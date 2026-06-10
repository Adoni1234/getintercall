import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AudioService } from './services/audio-service';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { io, Socket } from 'socket.io-client';
import { environment } from '../environments/environment';
import { Subscription } from 'rxjs';

interface Bloque { text: string; lang: string; }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule, MatIconModule],
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App implements AfterViewChecked, OnDestroy {
  title = 'GetIntercall';
  isRecording = false;
  transcription = '';
  loading = false;

  sessionDuration = '00:00:00';
  private timerInterval: any = null;
  private sessionStartTime = 0;

  @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

  private socket: Socket;
  private sessionId = '';
  private audioService = inject(AudioService);
  private cdr = inject(ChangeDetectorRef);
  private snackBar = inject(MatSnackBar);

  partialEn: Bloque = { text: '', lang: 'en' };
  partialEs: Bloque = { text: '', lang: 'es' };
  private partialEnTs = 0;
  private partialEsTs = 0;
  private lastBlockEnTs = 0;
  private lastBlockEsTs = 0;
  bloques: Bloque[] = [];

  showTranslationPanel = true;
  translations: Array<{
    original: string; translated: string;
    sourceLang: string; targetLang: string; translating: boolean;
  }> = [];

  autoScrollEnabled = true;
  private previousTranscriptionLength = 0;
  private chunkSubscription: Subscription | null = null;

  constructor() {
    this.socket = io(environment.apiUrl, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    this.socket.on('connect', () => console.log('✅ Socket conectado'));
    this.socket.on('disconnect', () => console.log('⚠️ Socket desconectado'));
    this.socket.on('reconnect', () => {
      if (this.isRecording && this.sessionId) {
        this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        this.socket.emit('startTranscription', { sessionId: this.sessionId });
      }
    });

    this.socket.on('partialTranscript', (dataStr: string) => {
      try {
        const data = JSON.parse(dataStr);
        if (data.sessionId !== this.sessionId) return;
        if (!data.text?.trim()) return;

        const text = data.text.trim();
        const lang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

        // ── CORRECCIÓN: reemplaza el bloque original in-place, no añade uno nuevo
        if (data.isCorrection) {
          const norm = (s: string) => s.toLowerCase()
            .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim();

          let replaced = false;

          // Buscar por originalText (match exacto normalizado)
          if (data.originalText) {
            const origNorm = norm(data.originalText);
            for (let i = this.bloques.length - 1; i >= 0; i--) {
              if (norm(this.bloques[i].text) === origNorm) {
                this.bloques[i] = { text, lang };
                console.log(`✨ Corrección in-place [${i}] [${lang}]:`, text.substring(0, 60));
                replaced = true;
                break;
              }
            }
          }

          // Fallback: último bloque del mismo idioma
          if (!replaced) {
            for (let i = this.bloques.length - 1; i >= 0; i--) {
              if (this.bloques[i].lang === lang) {
                this.bloques[i] = { text, lang };
                console.log(`✨ Corrección fallback [${lang}]:`, text.substring(0, 60));
                break;
              }
            }
          }

          // NUNCA añadir bloque nuevo en una corrección
          this.render();
          return;
        }

        // ── NUEVO TURNO ──────────────────────────────────────────────────────
        if (data.isNewTurn || data.isForcedClose) {
          if (lang === 'en') {
            this.partialEn = { text: '', lang: 'en' };
            this.partialEnTs = 0;
            this.lastBlockEnTs = Date.now();
          } else {
            this.partialEs = { text: '', lang: 'es' };
            this.partialEsTs = 0;
            this.lastBlockEsTs = Date.now();
          }

          const norm = (s: string) => s.toLowerCase()
            .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim()
            .replace(/keppra/gi, 'kepra').replace(/sí,?\s*/gi, 'si ').trim();
          const normNew = norm(text);

          const lastSameIdx = (() => {
            for (let i = this.bloques.length - 1; i >= 0; i--) {
              if (this.bloques[i].lang === lang) return i;
            }
            return -1;
          })();

          const lastAnyIdx = (() => {
            for (let i = this.bloques.length - 1; i >= 0; i--) {
              const normPrev = norm(this.bloques[i].text);
              const prefix = normPrev.substring(0, Math.min(normPrev.length, 15));
              if (prefix.length >= 4 && normNew.startsWith(prefix) && normNew.length > normPrev.length) {
                return i;
              }
            }
            return -1;
          })();

          const msSinceBlock = lang === 'en'
            ? Date.now() - this.lastBlockEnTs
            : Date.now() - this.lastBlockEsTs;

          // Cross-lang extension: ventana más corta (2s) para evitar absorber turnos distintos
          if (lastAnyIdx >= 0 && msSinceBlock < 2000 && lastAnyIdx !== lastSameIdx) {
            this.bloques[lastAnyIdx] = { text, lang };
            console.log(`🔄 Bloque extendido [cross-lang→${lang}]:`, text.substring(0, 60));
            this.render();
            return;
          }

          // Same-lang extension: reemplazar bloque anterior si el nuevo texto lo extiende
          if (lastSameIdx >= 0 && msSinceBlock < 2000) {
            const normPrev = norm(this.bloques[lastSameIdx].text);
            const prevWords = normPrev.split(/\s+/).filter(Boolean).length;
            // Para bloques de 1 palabra (ej: "si") el prefijo mínimo es toda la palabra
            // Para bloques de 2+ palabras usar los primeros 20 chars
            const minPrefixLen = prevWords <= 1
              ? normPrev.length       // toda la palabra debe coincidir
              : Math.min(normPrev.length, 20);
            const isExtension = minPrefixLen >= 2
              && normNew.startsWith(normPrev.substring(0, minPrefixLen))
              && normNew.length > normPrev.length;
            const isShortBackchannel = normNew.split(/\s+/).filter(Boolean).length <= 2;
            const isDuplicate = !isShortBackchannel && (normNew === normPrev
              || normPrev.startsWith(normNew.substring(0, Math.min(20, normNew.length))));

            if (isExtension) {
              this.bloques[lastSameIdx] = { text, lang };
              console.log(`🔄 Bloque extendido [${lang}]:`, text.substring(0, 60));
              this.render();
              return;
            }
            if (isDuplicate) {
              console.log(`🔇 Duplicado ignorado [${lang}]:`, text.substring(0, 60));
              this.render();
              return;
            }
          }

          this.bloques.push({ text, lang });
          console.log(`✅ Bloque [${lang}]:`, text.substring(0, 60));
          this.render();
          return;
        }

        // ── PARTIAL en vivo ──────────────────────────────────────────────────
        const now = Date.now();
        const lastBlockTs = lang === 'en' ? this.lastBlockEnTs : this.lastBlockEsTs;
        if (now - lastBlockTs < 400) {
          console.log(`🔇 Partial [${lang}] ignorado (eco post-bloque):`, text.substring(0, 40));
          return;
        }

        if (lang === 'en') {
          const currentEn = this.partialEn.text;
          if (!currentEn || text.length >= currentEn.length * 0.7 || text.length > currentEn.length) {
            this.partialEn = { text, lang: 'en' };
          }
          this.partialEnTs = now;
          if (this.partialEs.text && now - this.partialEsTs > 2500) {
            this.partialEs = { text: '', lang: 'es' };
          }
        } else {
          const currentEs = this.partialEs.text;
          if (!currentEs || text.length >= currentEs.length * 0.7 || text.length > currentEs.length) {
            this.partialEs = { text, lang: 'es' };
          }
          this.partialEsTs = now;
          if (this.partialEn.text && now - this.partialEnTs > 2500) {
            this.partialEn = { text: '', lang: 'en' };
          }
        }

        console.log(`📝 Partial [${lang}]:`, text.substring(0, 50));
        this.render();

      } catch (e) {
        console.error('❌ Error parsing partialTranscript:', e, dataStr);
      }
    });

    this.socket.on('error', (err: any) => {
      this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
    });

    this.socket.on('started', () => { this.loading = false; });

    this.socket.on('stopped', () => {
      if (this.partialEn.text.trim()) {
        this.bloques.push({ ...this.partialEn });
        this.partialEn = { text: '', lang: 'en' };
      }
      if (this.partialEs.text.trim()) {
        this.bloques.push({ ...this.partialEs });
        this.partialEs = { text: '', lang: 'es' };
      }
      this.render();
    });
  }

  private render(): void {
    this.transcription = this.bloques
      .filter(b => b.text.trim())
      .map(b => b.text)
      .join('\n\n');
    this.cdr.detectChanges();
    if (this.transcription.length > this.previousTranscriptionLength) {
      setTimeout(() => this.scrollToBottom(), 50);
      this.previousTranscriptionLength = this.transcription.length;
    }
  }

  get activePartial(): Bloque | null {
    const hasEn = this.partialEn.text.trim().length > 0;
    const hasEs = this.partialEs.text.trim().length > 0;
    if (!hasEn && !hasEs) return null;
    if (hasEn && !hasEs) return this.partialEn;
    if (!hasEn && hasEs) return this.partialEs;
    return this.partialEn.text.length >= this.partialEs.text.length ? this.partialEn : this.partialEs;
  }

  async startRecording() {
    try {
      await this.audioService.startTabAudioCapture();
      this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      this.isRecording = true;
      this.transcription = '';
      this.bloques = [];
      this.partialEn = { text: '', lang: 'en' };
      this.partialEs = { text: '', lang: 'es' };
      this.previousTranscriptionLength = 0;
      this.loading = true;
      this.translations = [];
      this.startTimer();
      this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });
      this.socket.emit('startTranscription', { sessionId: this.sessionId });

      if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
      this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
        const uint8 = new Uint8Array(buffer);
        this.socket.emit('audioChunk', { sessionId: this.sessionId, chunk: Array.from(uint8) });
      });
    } catch (err: any) {
      this.loading = false;
      this.isRecording = false;
      this.stopTimer();
      let msg = err.message || 'Error al iniciar captura.';
      if (err.name === 'NotSupportedError') msg = 'Screen capture no soportado. Usa Chrome + HTTPS.';
      if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio".';
      if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona pestaña con audio.';
      this.snackBar.open(msg, 'OK', { duration: 5000 });
    }
  }

  stopRecording() {
    this.socket.emit('stopTranscription', { sessionId: this.sessionId });
    this.audioService.stopRecording();
    this.isRecording = false;
    this.loading = false;
    this.stopTimer();
    if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
    this.partialEn = { text: '', lang: 'en' };
    this.partialEs = { text: '', lang: 'es' };
    this.bloques = [];
    this.transcription = '';
    this.translations = [];
    this.previousTranscriptionLength = 0;
    this.cdr.detectChanges();
    this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
  }

  clearTranscription() {
    const wasEmpty = this.bloques.length === 0 && !this.partialEn.text && !this.partialEs.text;
    this.transcription = '';
    this.bloques = [];
    this.partialEn = { text: '', lang: 'en' };
    this.partialEs = { text: '', lang: 'es' };
    this.previousTranscriptionLength = 0;
    this.cdr.detectChanges();
    if (!wasEmpty) this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
  }

  private startTimer(): void {
    this.sessionStartTime = Date.now();
    this.sessionDuration = '00:00:00';
    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
      const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
      const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toString().padStart(2, '0');
      this.sessionDuration = `${h}:${m}:${s}`;
      this.cdr.detectChanges();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    this.sessionDuration = '00:00:00';
  }

  private detectLanguageFrontend(text: string): 'es' | 'en' {
    const t = text.toLowerCase().trim();
    if (/[áéíóúñ¿¡]/i.test(t)) return 'es';
    if (/^(sí|si|no|ya|yo|mi|tu|su|lo|la|le|un|al|del|eh|ay|fue|hay|hoy|más|nos|eso|ese|esa|con|por|que|muy|son|han|van|voy|soy|da|ir)$/.test(t)) return 'es';
    if (/\b(de|del|el|la|los|las|un|una|está|son|es|por|para|con|pero|y|me|te|se|lo|le|sí|desde|hace|porque|cuando|tengo|tiene)\b/gi.test(t)) return 'es';
    return 'en';
  }

  addTranslation(text: string): void {
    const isSpanish = this.detectLanguageFrontend(text) === 'es';
    const translation = {
      original: text, translated: '',
      sourceLang: isSpanish ? 'es' : 'en',
      targetLang: isSpanish ? 'en' : 'es',
      translating: true
    };
    this.translations.unshift(translation);
    this.translateItem(translation);
  }

  async translateItem(translation: any): Promise<void> {
    try {
      const textToTranslate = translation.original.length > 500
        ? translation.original.substring(0, 500) + '...'
        : translation.original;
      let translated = '';
      let success = false;

      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${translation.sourceLang}|${translation.targetLang}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          if (data.responseStatus === 200 && data.responseData?.translatedText) {
            const t = data.responseData.translatedText;
            if (t && t !== textToTranslate && !t.toLowerCase().includes('mymemory')) { translated = t; success = true; }
          }
        }
      } catch { }

      if (!success) {
        try {
          const url = `https://lingva.ml/api/v1/${translation.sourceLang}/${translation.targetLang}/${encodeURIComponent(textToTranslate)}`;
          const response = await fetch(url);
          if (response.ok) { const data = await response.json(); if (data.translation) { translated = data.translation; success = true; } }
        } catch { }
      }

      translation.translated = success && translated ? translated : '⚠️ Traducción no disponible';
      translation.translating = false;
      this.cdr.detectChanges();
    } catch {
      translation.translated = '⚠️ Error al traducir';
      translation.translating = false;
      this.cdr.detectChanges();
    }
  }

  onTextSelection(): void {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (selectedText && selectedText.length > 0) {
      const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
      if (selectedText.length > 500) this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
      this.addTranslation(textToTranslate);
      selection?.removeAllRanges();
    }
  }

  removeTranslation(index: number): void { this.translations.splice(index, 1); }
  clearAllTranslations(): void { this.translations = []; }
  toggleTranslationPanel(): void {}
  async translateSelection(): Promise<void> {}
  closeTranslation(): void {}

  ngAfterViewChecked(): void {
    if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
  }

  ngOnDestroy() {
    this.stopTimer();
    if (this.chunkSubscription) this.chunkSubscription.unsubscribe();
    this.socket.disconnect();
  }

  private scrollToBottom(): void {
    if (this.scrollMe && this.autoScrollEnabled) {
      const el = this.scrollMe.nativeElement;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }

  private isAtBottom(): boolean {
    if (this.scrollMe) {
      const el = this.scrollMe.nativeElement;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    }
    return false;
  }

  onContainerScroll(): void {
    this.autoScrollEnabled = this.isAtBottom();
  }
}

// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, OnDestroy } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { AudioService } from './services/audio-service';
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { MatIconModule } from '@angular/material/icon';
// import { io, Socket } from 'socket.io-client';
// import { environment } from '../environments/environment';
// import { Subscription } from 'rxjs';

// interface Bloque { text: string; lang: string; }

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [CommonModule, MatCardModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule, MatIconModule],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked, OnDestroy {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   sessionDuration = '00:00:00';
//   private timerInterval: any = null;
//   private sessionStartTime = 0;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private socket: Socket;
//   private sessionId = '';
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);

//   partialEn: Bloque = { text: '', lang: 'en' };
//   partialEs: Bloque = { text: '', lang: 'es' };
//   private partialEnTs = 0;
//   private partialEsTs = 0;
//   private lastBlockEnTs = 0;
//   private lastBlockEsTs = 0;
//   bloques: Bloque[] = [];

//   showTranslationPanel = true;
//   translations: Array<{
//     original: string; translated: string;
//     sourceLang: string; targetLang: string; translating: boolean;
//   }> = [];

//   autoScrollEnabled = true;
//   private previousTranscriptionLength = 0;
//   private chunkSubscription: Subscription | null = null;

//   constructor() {
//     this.socket = io(environment.apiUrl, {
//       reconnection: true,
//       reconnectionAttempts: Infinity,
//       reconnectionDelay: 1000,
//       reconnectionDelayMax: 5000,
//       timeout: 20000,
//     });

//     this.socket.on('connect', () => console.log('✅ Socket conectado'));
//     this.socket.on('disconnect', () => console.log('⚠️ Socket desconectado'));
//     this.socket.on('reconnect', () => {
//       if (this.isRecording && this.sessionId) {
//         this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//         this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       }
//     });

//     this.socket.on('partialTranscript', (dataStr: string) => {
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId !== this.sessionId) return;
//         if (!data.text?.trim()) return;

//         const text = data.text.trim();
//         const lang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

//         // ── CORRECCIÓN: reemplaza el bloque original in-place, no añade uno nuevo
//         if (data.isCorrection) {
//           const norm = (s: string) => s.toLowerCase()
//             .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim();

//           let replaced = false;

//           // Buscar por originalText (match exacto normalizado)
//           if (data.originalText) {
//             const origNorm = norm(data.originalText);
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (norm(this.bloques[i].text) === origNorm) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección in-place [${i}] [${lang}]:`, text.substring(0, 60));
//                 replaced = true;
//                 break;
//               }
//             }
//           }

//           // Fallback: último bloque del mismo idioma
//           if (!replaced) {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección fallback [${lang}]:`, text.substring(0, 60));
//                 break;
//               }
//             }
//           }

//           // NUNCA añadir bloque nuevo en una corrección
//           this.render();
//           return;
//         }

//         // ── NUEVO TURNO ──────────────────────────────────────────────────────
//         if (data.isNewTurn || data.isForcedClose) {
//           if (lang === 'en') {
//             this.partialEn = { text: '', lang: 'en' };
//             this.partialEnTs = 0;
//             this.lastBlockEnTs = Date.now();
//           } else {
//             this.partialEs = { text: '', lang: 'es' };
//             this.partialEsTs = 0;
//             this.lastBlockEsTs = Date.now();
//           }

//           const norm = (s: string) => s.toLowerCase()
//             .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim()
//             .replace(/keppra/gi, 'kepra').replace(/sí,?\s*/gi, 'si ').trim();
//           const normNew = norm(text);

//           const lastSameIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) return i;
//             }
//             return -1;
//           })();

//           const lastAnyIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               const normPrev = norm(this.bloques[i].text);
//               const prefix = normPrev.substring(0, Math.min(normPrev.length, 15));
//               if (prefix.length >= 4 && normNew.startsWith(prefix) && normNew.length > normPrev.length) {
//                 return i;
//               }
//             }
//             return -1;
//           })();

//           const msSinceBlock = lang === 'en'
//             ? Date.now() - this.lastBlockEnTs
//             : Date.now() - this.lastBlockEsTs;

//           // Cross-lang extension: ventana más corta (2s) para evitar absorber turnos distintos
//           if (lastAnyIdx >= 0 && msSinceBlock < 2000 && lastAnyIdx !== lastSameIdx) {
//             this.bloques[lastAnyIdx] = { text, lang };
//             console.log(`🔄 Bloque extendido [cross-lang→${lang}]:`, text.substring(0, 60));
//             this.render();
//             return;
//           }

//           // Same-lang extension: solo extender si el nuevo texto empieza con el previo (es continuación real)
//           // Ventana de 2s — evita que "Sí, pero lo dejé." absorba "Sí, Keppra." que es un turno distinto
//           if (lastSameIdx >= 0 && msSinceBlock < 2000) {
//             const normPrev = norm(this.bloques[lastSameIdx].text);
//             // Solo extender si el nuevo empieza con el texto previo (continuación directa)
//             // NO extender si comparten solo el inicio de "sí" — eso son respuestas distintas
//             const prevWords = normPrev.split(/\s+/).filter(Boolean).length;
//             const minPrefixLen = prevWords <= 2 ? Math.min(normPrev.length, 6) : Math.min(normPrev.length, 20);
//             const isExtension = minPrefixLen >= 3
//               && normNew.startsWith(normPrev.substring(0, minPrefixLen))
//               && normNew.length > normPrev.length;
//             const isShortBackchannel = normNew.split(/\s+/).filter(Boolean).length <= 2;
//             const isDuplicate = !isShortBackchannel && (normNew === normPrev
//               || normPrev.startsWith(normNew.substring(0, Math.min(20, normNew.length))));

//             if (isExtension) {
//               this.bloques[lastSameIdx] = { text, lang };
//               console.log(`🔄 Bloque extendido [${lang}]:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//             if (isDuplicate) {
//               console.log(`🔇 Duplicado ignorado [${lang}]:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//           }

//           this.bloques.push({ text, lang });
//           console.log(`✅ Bloque [${lang}]:`, text.substring(0, 60));
//           this.render();
//           return;
//         }

//         // ── PARTIAL en vivo ──────────────────────────────────────────────────
//         const now = Date.now();
//         const lastBlockTs = lang === 'en' ? this.lastBlockEnTs : this.lastBlockEsTs;
//         if (now - lastBlockTs < 400) {
//           console.log(`🔇 Partial [${lang}] ignorado (eco post-bloque):`, text.substring(0, 40));
//           return;
//         }

//         if (lang === 'en') {
//           const currentEn = this.partialEn.text;
//           if (!currentEn || text.length >= currentEn.length * 0.7 || text.length > currentEn.length) {
//             this.partialEn = { text, lang: 'en' };
//           }
//           this.partialEnTs = now;
//           if (this.partialEs.text && now - this.partialEsTs > 2500) {
//             this.partialEs = { text: '', lang: 'es' };
//           }
//         } else {
//           const currentEs = this.partialEs.text;
//           if (!currentEs || text.length >= currentEs.length * 0.7 || text.length > currentEs.length) {
//             this.partialEs = { text, lang: 'es' };
//           }
//           this.partialEsTs = now;
//           if (this.partialEn.text && now - this.partialEnTs > 2500) {
//             this.partialEn = { text: '', lang: 'en' };
//           }
//         }

//         console.log(`📝 Partial [${lang}]:`, text.substring(0, 50));
//         this.render();

//       } catch (e) {
//         console.error('❌ Error parsing partialTranscript:', e, dataStr);
//       }
//     });

//     this.socket.on('error', (err: any) => {
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });

//     this.socket.on('started', () => { this.loading = false; });

//     this.socket.on('stopped', () => {
//       if (this.partialEn.text.trim()) {
//         this.bloques.push({ ...this.partialEn });
//         this.partialEn = { text: '', lang: 'en' };
//       }
//       if (this.partialEs.text.trim()) {
//         this.bloques.push({ ...this.partialEs });
//         this.partialEs = { text: '', lang: 'es' };
//       }
//       this.render();
//     });
//   }

//   private render(): void {
//     this.transcription = this.bloques
//       .filter(b => b.text.trim())
//       .map(b => b.text)
//       .join('\n\n');
//     this.cdr.detectChanges();
//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 50);
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   get activePartial(): Bloque | null {
//     const hasEn = this.partialEn.text.trim().length > 0;
//     const hasEs = this.partialEs.text.trim().length > 0;
//     if (!hasEn && !hasEs) return null;
//     if (hasEn && !hasEs) return this.partialEn;
//     if (!hasEn && hasEs) return this.partialEs;
//     return this.partialEn.text.length >= this.partialEs.text.length ? this.partialEn : this.partialEs;
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();
//       this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.partialEn = { text: '', lang: 'en' };
//       this.partialEs = { text: '', lang: 'es' };
//       this.previousTranscriptionLength = 0;
//       this.loading = true;
//       this.translations = [];
//       this.startTimer();
//       this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });
//       this.socket.emit('startTranscription', { sessionId: this.sessionId });

//       if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//       this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
//         const uint8 = new Uint8Array(buffer);
//         this.socket.emit('audioChunk', { sessionId: this.sessionId, chunk: Array.from(uint8) });
//       });
//     } catch (err: any) {
//       this.loading = false;
//       this.isRecording = false;
//       this.stopTimer();
//       let msg = err.message || 'Error al iniciar captura.';
//       if (err.name === 'NotSupportedError') msg = 'Screen capture no soportado. Usa Chrome + HTTPS.';
//       if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio".';
//       if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona pestaña con audio.';
//       this.snackBar.open(msg, 'OK', { duration: 5000 });
//     }
//   }

//   stopRecording() {
//     this.socket.emit('stopTranscription', { sessionId: this.sessionId });
//     this.audioService.stopRecording();
//     this.isRecording = false;
//     this.loading = false;
//     this.stopTimer();
//     if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.bloques = [];
//     this.transcription = '';
//     this.translations = [];
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
//   }

//   clearTranscription() {
//     const wasEmpty = this.bloques.length === 0 && !this.partialEn.text && !this.partialEs.text;
//     this.transcription = '';
//     this.bloques = [];
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     if (!wasEmpty) this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
//   }

//   private startTimer(): void {
//     this.sessionStartTime = Date.now();
//     this.sessionDuration = '00:00:00';
//     this.timerInterval = setInterval(() => {
//       const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
//       const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
//       const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
//       const s = (elapsed % 60).toString().padStart(2, '0');
//       this.sessionDuration = `${h}:${m}:${s}`;
//       this.cdr.detectChanges();
//     }, 1000);
//   }

//   private stopTimer(): void {
//     if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
//     this.sessionDuration = '00:00:00';
//   }

//   private detectLanguageFrontend(text: string): 'es' | 'en' {
//     const t = text.toLowerCase().trim();
//     if (/[áéíóúñ¿¡]/i.test(t)) return 'es';
//     if (/^(sí|si|no|ya|yo|mi|tu|su|lo|la|le|un|al|del|eh|ay|fue|hay|hoy|más|nos|eso|ese|esa|con|por|que|muy|son|han|van|voy|soy|da|ir)$/.test(t)) return 'es';
//     if (/\b(de|del|el|la|los|las|un|una|está|son|es|por|para|con|pero|y|me|te|se|lo|le|sí|desde|hace|porque|cuando|tengo|tiene)\b/gi.test(t)) return 'es';
//     return 'en';
//   }

//   addTranslation(text: string): void {
//     const isSpanish = this.detectLanguageFrontend(text) === 'es';
//     const translation = {
//       original: text, translated: '',
//       sourceLang: isSpanish ? 'es' : 'en',
//       targetLang: isSpanish ? 'en' : 'es',
//       translating: true
//     };
//     this.translations.unshift(translation);
//     this.translateItem(translation);
//   }

//   async translateItem(translation: any): Promise<void> {
//     try {
//       const textToTranslate = translation.original.length > 500
//         ? translation.original.substring(0, 500) + '...'
//         : translation.original;
//       let translated = '';
//       let success = false;

//       try {
//         const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${translation.sourceLang}|${translation.targetLang}`;
//         const response = await fetch(url);
//         if (response.ok) {
//           const data = await response.json();
//           if (data.responseStatus === 200 && data.responseData?.translatedText) {
//             const t = data.responseData.translatedText;
//             if (t && t !== textToTranslate && !t.toLowerCase().includes('mymemory')) { translated = t; success = true; }
//           }
//         }
//       } catch { }

//       if (!success) {
//         try {
//           const url = `https://lingva.ml/api/v1/${translation.sourceLang}/${translation.targetLang}/${encodeURIComponent(textToTranslate)}`;
//           const response = await fetch(url);
//           if (response.ok) { const data = await response.json(); if (data.translation) { translated = data.translation; success = true; } }
//         } catch { }
//       }

//       translation.translated = success && translated ? translated : '⚠️ Traducción no disponible';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     } catch {
//       translation.translated = '⚠️ Error al traducir';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     }
//   }

//   onTextSelection(): void {
//     const selection = window.getSelection();
//     const selectedText = selection?.toString().trim();
//     if (selectedText && selectedText.length > 0) {
//       const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
//       if (selectedText.length > 500) this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
//       this.addTranslation(textToTranslate);
//       selection?.removeAllRanges();
//     }
//   }

//   removeTranslation(index: number): void { this.translations.splice(index, 1); }
//   clearAllTranslations(): void { this.translations = []; }
//   toggleTranslationPanel(): void {}
//   async translateSelection(): Promise<void> {}
//   closeTranslation(): void {}

//   ngAfterViewChecked(): void {
//     if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
//   }

//   ngOnDestroy() {
//     this.stopTimer();
//     if (this.chunkSubscription) this.chunkSubscription.unsubscribe();
//     this.socket.disconnect();
//   }

//   private scrollToBottom(): void {
//     if (this.scrollMe && this.autoScrollEnabled) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
//     }
//   }

//   private isAtBottom(): boolean {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       return el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
//     }
//     return false;
//   }

//   onContainerScroll(): void {
//     this.autoScrollEnabled = this.isAtBottom();
//   }
// }
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, OnDestroy } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { AudioService } from './services/audio-service';
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { MatIconModule } from '@angular/material/icon';
// import { io, Socket } from 'socket.io-client';
// import { environment } from '../environments/environment';
// import { Subscription } from 'rxjs';

// interface Bloque { text: string; lang: string; }

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [CommonModule, MatCardModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule, MatIconModule],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked, OnDestroy {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   sessionDuration = '00:00:00';
//   private timerInterval: any = null;
//   private sessionStartTime = 0;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private socket: Socket;
//   private sessionId = '';
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);

//   partialEn: Bloque = { text: '', lang: 'en' };
//   partialEs: Bloque = { text: '', lang: 'es' };
//   private partialEnTs = 0;
//   private partialEsTs = 0;
//   private lastBlockEnTs = 0;
//   private lastBlockEsTs = 0;
//   bloques: Bloque[] = [];

//   showTranslationPanel = true;
//   translations: Array<{
//     original: string; translated: string;
//     sourceLang: string; targetLang: string; translating: boolean;
//   }> = [];

//   autoScrollEnabled = true;
//   private previousTranscriptionLength = 0;
//   private chunkSubscription: Subscription | null = null;

//   constructor() {
//     this.socket = io(environment.apiUrl, {
//       reconnection: true,
//       reconnectionAttempts: Infinity,
//       reconnectionDelay: 1000,
//       reconnectionDelayMax: 5000,
//       timeout: 20000,
//     });

//     this.socket.on('connect', () => console.log('✅ Socket conectado'));
//     this.socket.on('disconnect', () => console.log('⚠️ Socket desconectado'));
//     this.socket.on('reconnect', () => {
//       if (this.isRecording && this.sessionId) {
//         this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//         this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       }
//     });

//     this.socket.on('partialTranscript', (dataStr: string) => {
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId !== this.sessionId) return;
//         if (!data.text?.trim()) return;

//         const text = data.text.trim();
//         const lang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

//         // ── CORRECCIÓN: reemplaza el bloque original in-place, no añade uno nuevo
//         if (data.isCorrection) {
//           const norm = (s: string) => s.toLowerCase()
//             .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim();

//           let replaced = false;

//           // Buscar por originalText (match exacto normalizado)
//           if (data.originalText) {
//             const origNorm = norm(data.originalText);
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (norm(this.bloques[i].text) === origNorm) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección in-place [${i}] [${lang}]:`, text.substring(0, 60));
//                 replaced = true;
//                 break;
//               }
//             }
//           }

//           // Fallback: último bloque del mismo idioma
//           if (!replaced) {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección fallback [${lang}]:`, text.substring(0, 60));
//                 break;
//               }
//             }
//           }

//           // NUNCA añadir bloque nuevo en una corrección
//           this.render();
//           return;
//         }

//         // ── NUEVO TURNO ──────────────────────────────────────────────────────
//         if (data.isNewTurn || data.isForcedClose) {
//           if (lang === 'en') {
//             this.partialEn = { text: '', lang: 'en' };
//             this.partialEnTs = 0;
//             this.lastBlockEnTs = Date.now();
//           } else {
//             this.partialEs = { text: '', lang: 'es' };
//             this.partialEsTs = 0;
//             this.lastBlockEsTs = Date.now();
//           }

//           const norm = (s: string) => s.toLowerCase()
//             .replace(/[.,?!¿¡]/g, '').replace(/\s+/g, ' ').trim()
//             .replace(/keppra/gi, 'kepra').replace(/sí,?\s*/gi, 'si ').trim();
//           const normNew = norm(text);

//           const lastSameIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) return i;
//             }
//             return -1;
//           })();

//           const lastAnyIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               const normPrev = norm(this.bloques[i].text);
//               const prefix = normPrev.substring(0, Math.min(normPrev.length, 15));
//               if (prefix.length >= 4 && normNew.startsWith(prefix) && normNew.length > normPrev.length) {
//                 return i;
//               }
//             }
//             return -1;
//           })();

//           const msSinceBlock = lang === 'en'
//             ? Date.now() - this.lastBlockEnTs
//             : Date.now() - this.lastBlockEsTs;

//           if (lastAnyIdx >= 0 && msSinceBlock < 3500 && lastAnyIdx !== lastSameIdx) {
//             this.bloques[lastAnyIdx] = { text, lang };
//             console.log(`🔄 Bloque extendido [cross-lang→${lang}]:`, text.substring(0, 60));
//             this.render();
//             return;
//           }

//           if (lastSameIdx >= 0 && msSinceBlock < 3500) {
//             const normPrev = norm(this.bloques[lastSameIdx].text);
//             const isExtension = normNew.startsWith(normPrev.substring(0, Math.min(20, normPrev.length)))
//               && normNew.length > normPrev.length;
//             const isShortBackchannel = normNew.split(/\s+/).filter(Boolean).length <= 2;
//             const isDuplicate = !isShortBackchannel && (normNew === normPrev
//               || normPrev.startsWith(normNew.substring(0, Math.min(20, normNew.length))));

//             if (isExtension) {
//               this.bloques[lastSameIdx] = { text, lang };
//               console.log(`🔄 Bloque extendido [${lang}]:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//             if (isDuplicate) {
//               console.log(`🔇 Duplicado ignorado [${lang}]:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//           }

//           this.bloques.push({ text, lang });
//           console.log(`✅ Bloque [${lang}]:`, text.substring(0, 60));
//           this.render();
//           return;
//         }

//         // ── PARTIAL en vivo ──────────────────────────────────────────────────
//         const now = Date.now();
//         const lastBlockTs = lang === 'en' ? this.lastBlockEnTs : this.lastBlockEsTs;
//         if (now - lastBlockTs < 400) {
//           console.log(`🔇 Partial [${lang}] ignorado (eco post-bloque):`, text.substring(0, 40));
//           return;
//         }

//         if (lang === 'en') {
//           const currentEn = this.partialEn.text;
//           if (!currentEn || text.length >= currentEn.length * 0.7 || text.length > currentEn.length) {
//             this.partialEn = { text, lang: 'en' };
//           }
//           this.partialEnTs = now;
//           if (this.partialEs.text && now - this.partialEsTs > 2500) {
//             this.partialEs = { text: '', lang: 'es' };
//           }
//         } else {
//           const currentEs = this.partialEs.text;
//           if (!currentEs || text.length >= currentEs.length * 0.7 || text.length > currentEs.length) {
//             this.partialEs = { text, lang: 'es' };
//           }
//           this.partialEsTs = now;
//           if (this.partialEn.text && now - this.partialEnTs > 2500) {
//             this.partialEn = { text: '', lang: 'en' };
//           }
//         }

//         console.log(`📝 Partial [${lang}]:`, text.substring(0, 50));
//         this.render();

//       } catch (e) {
//         console.error('❌ Error parsing partialTranscript:', e, dataStr);
//       }
//     });

//     this.socket.on('error', (err: any) => {
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });

//     this.socket.on('started', () => { this.loading = false; });

//     this.socket.on('stopped', () => {
//       if (this.partialEn.text.trim()) {
//         this.bloques.push({ ...this.partialEn });
//         this.partialEn = { text: '', lang: 'en' };
//       }
//       if (this.partialEs.text.trim()) {
//         this.bloques.push({ ...this.partialEs });
//         this.partialEs = { text: '', lang: 'es' };
//       }
//       this.render();
//     });
//   }

//   private render(): void {
//     this.transcription = this.bloques
//       .filter(b => b.text.trim())
//       .map(b => b.text)
//       .join('\n\n');
//     this.cdr.detectChanges();
//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 50);
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   get activePartial(): Bloque | null {
//     const hasEn = this.partialEn.text.trim().length > 0;
//     const hasEs = this.partialEs.text.trim().length > 0;
//     if (!hasEn && !hasEs) return null;
//     if (hasEn && !hasEs) return this.partialEn;
//     if (!hasEn && hasEs) return this.partialEs;
//     return this.partialEn.text.length >= this.partialEs.text.length ? this.partialEn : this.partialEs;
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();
//       this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.partialEn = { text: '', lang: 'en' };
//       this.partialEs = { text: '', lang: 'es' };
//       this.previousTranscriptionLength = 0;
//       this.loading = true;
//       this.translations = [];
//       this.startTimer();
//       this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });
//       this.socket.emit('startTranscription', { sessionId: this.sessionId });

//       if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//       this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
//         const uint8 = new Uint8Array(buffer);
//         this.socket.emit('audioChunk', { sessionId: this.sessionId, chunk: Array.from(uint8) });
//       });
//     } catch (err: any) {
//       this.loading = false;
//       this.isRecording = false;
//       this.stopTimer();
//       let msg = err.message || 'Error al iniciar captura.';
//       if (err.name === 'NotSupportedError') msg = 'Screen capture no soportado. Usa Chrome + HTTPS.';
//       if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio".';
//       if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona pestaña con audio.';
//       this.snackBar.open(msg, 'OK', { duration: 5000 });
//     }
//   }

//   stopRecording() {
//     this.socket.emit('stopTranscription', { sessionId: this.sessionId });
//     this.audioService.stopRecording();
//     this.isRecording = false;
//     this.loading = false;
//     this.stopTimer();
//     if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.bloques = [];
//     this.transcription = '';
//     this.translations = [];
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
//   }

//   clearTranscription() {
//     const wasEmpty = this.bloques.length === 0 && !this.partialEn.text && !this.partialEs.text;
//     this.transcription = '';
//     this.bloques = [];
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     if (!wasEmpty) this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
//   }

//   private startTimer(): void {
//     this.sessionStartTime = Date.now();
//     this.sessionDuration = '00:00:00';
//     this.timerInterval = setInterval(() => {
//       const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
//       const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
//       const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
//       const s = (elapsed % 60).toString().padStart(2, '0');
//       this.sessionDuration = `${h}:${m}:${s}`;
//       this.cdr.detectChanges();
//     }, 1000);
//   }

//   private stopTimer(): void {
//     if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
//     this.sessionDuration = '00:00:00';
//   }

//   private detectLanguageFrontend(text: string): 'es' | 'en' {
//     const t = text.toLowerCase().trim();
//     if (/[áéíóúñ¿¡]/i.test(t)) return 'es';
//     if (/^(sí|si|no|ya|yo|mi|tu|su|lo|la|le|un|al|del|eh|ay|fue|hay|hoy|más|nos|eso|ese|esa|con|por|que|muy|son|han|van|voy|soy|da|ir)$/.test(t)) return 'es';
//     if (/\b(de|del|el|la|los|las|un|una|está|son|es|por|para|con|pero|y|me|te|se|lo|le|sí|desde|hace|porque|cuando|tengo|tiene)\b/gi.test(t)) return 'es';
//     return 'en';
//   }

//   addTranslation(text: string): void {
//     const isSpanish = this.detectLanguageFrontend(text) === 'es';
//     const translation = {
//       original: text, translated: '',
//       sourceLang: isSpanish ? 'es' : 'en',
//       targetLang: isSpanish ? 'en' : 'es',
//       translating: true
//     };
//     this.translations.unshift(translation);
//     this.translateItem(translation);
//   }

//   async translateItem(translation: any): Promise<void> {
//     try {
//       const textToTranslate = translation.original.length > 500
//         ? translation.original.substring(0, 500) + '...'
//         : translation.original;
//       let translated = '';
//       let success = false;

//       try {
//         const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${translation.sourceLang}|${translation.targetLang}`;
//         const response = await fetch(url);
//         if (response.ok) {
//           const data = await response.json();
//           if (data.responseStatus === 200 && data.responseData?.translatedText) {
//             const t = data.responseData.translatedText;
//             if (t && t !== textToTranslate && !t.toLowerCase().includes('mymemory')) { translated = t; success = true; }
//           }
//         }
//       } catch { }

//       if (!success) {
//         try {
//           const url = `https://lingva.ml/api/v1/${translation.sourceLang}/${translation.targetLang}/${encodeURIComponent(textToTranslate)}`;
//           const response = await fetch(url);
//           if (response.ok) { const data = await response.json(); if (data.translation) { translated = data.translation; success = true; } }
//         } catch { }
//       }

//       translation.translated = success && translated ? translated : '⚠️ Traducción no disponible';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     } catch {
//       translation.translated = '⚠️ Error al traducir';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     }
//   }

//   onTextSelection(): void {
//     const selection = window.getSelection();
//     const selectedText = selection?.toString().trim();
//     if (selectedText && selectedText.length > 0) {
//       const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
//       if (selectedText.length > 500) this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
//       this.addTranslation(textToTranslate);
//       selection?.removeAllRanges();
//     }
//   }

//   removeTranslation(index: number): void { this.translations.splice(index, 1); }
//   clearAllTranslations(): void { this.translations = []; }
//   toggleTranslationPanel(): void {}
//   async translateSelection(): Promise<void> {}
//   closeTranslation(): void {}

//   ngAfterViewChecked(): void {
//     if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
//   }

//   ngOnDestroy() {
//     this.stopTimer();
//     if (this.chunkSubscription) this.chunkSubscription.unsubscribe();
//     this.socket.disconnect();
//   }

//   private scrollToBottom(): void {
//     if (this.scrollMe && this.autoScrollEnabled) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
//     }
//   }

//   private isAtBottom(): boolean {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       return el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
//     }
//     return false;
//   }

//   onContainerScroll(): void {
//     this.autoScrollEnabled = this.isAtBottom();
//   }
// }
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, OnDestroy } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { AudioService } from './services/audio-service';
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { MatIconModule } from '@angular/material/icon';
// import { io, Socket } from 'socket.io-client';
// import { environment } from '../environments/environment';
// import { Subscription } from 'rxjs';

// interface Bloque { text: string; lang: string; }

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [CommonModule, MatCardModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule, MatIconModule],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked, OnDestroy {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   sessionDuration = '00:00:00';
//   private timerInterval: any = null;
//   private sessionStartTime = 0;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private socket: Socket;
//   private sessionId = '';
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);

//   // ── Estado de transcripción ───────────────────────────────────────────────
//   partialEn: Bloque = { text: '', lang: 'en' };
//   partialEs: Bloque = { text: '', lang: 'es' };
//   private partialEnTs = 0;
//   private partialEsTs = 0;
//   private lastBlockEnTs = 0;
//   private lastBlockEsTs = 0;
//   bloques: Bloque[] = [];

//   // Panel de traducción
//   showTranslationPanel = true;
//   translations: Array<{
//     original: string; translated: string;
//     sourceLang: string; targetLang: string; translating: boolean;
//   }> = [];

//   autoScrollEnabled = true;
//   private previousTranscriptionLength = 0;
//   private chunkSubscription: Subscription | null = null;

//   constructor() {
//     this.socket = io(environment.apiUrl, {
//       reconnection: true,
//       reconnectionAttempts: Infinity,
//       reconnectionDelay: 1000,
//       reconnectionDelayMax: 5000,
//       timeout: 20000,
//     });

//     this.socket.on('connect', () => console.log('✅ Socket conectado'));
//     this.socket.on('disconnect', () => console.log('⚠️ Socket desconectado'));
//     this.socket.on('reconnect', () => {
//       if (this.isRecording && this.sessionId) {
//         this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//         this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       }
//     });

//     this.socket.on('partialTranscript', (dataStr: string) => {
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId !== this.sessionId) return;
//         if (!data.text?.trim()) return;

//         const text = data.text.trim();
//         const lang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

//         // ── CORRECCIÓN: buscar por originalText primero, luego por idioma ────
//         if (data.isCorrection) {
//           const norm = (s: string) => s.toLowerCase().replace(/[.,?!¿¡]/g,'').replace(/\s+/g,' ').trim();
//           let found = false;

//           // Si el backend envió originalText, buscar el bloque que coincida exactamente
//           if (data.originalText) {
//             const origNorm = norm(data.originalText);
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (norm(this.bloques[i].text) === origNorm) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección [${this.bloques[i].lang}→${lang}]:`, text.substring(0, 50));
//                 found = true;
//                 break;
//               }
//             }
//           }

//           // Fallback: buscar por idioma (mismo comportamiento anterior)
//           if (!found) {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) {
//                 this.bloques[i] = { text, lang };
//                 console.log(`✨ Corrección [${lang}]:`, text.substring(0, 50));
//                 break;
//               }
//             }
//           }

//           this.render();
//           return;
//         }

//         // ── NUEVO TURNO: bloque definitivo del backend ───────────────────────
//         if (data.isNewTurn || data.isForcedClose) {
//           if (lang === 'en') {
//             this.partialEn = { text: '', lang: 'en' };
//             this.partialEnTs = 0;
//             this.lastBlockEnTs = Date.now();
//           } else {
//             this.partialEs = { text: '', lang: 'es' };
//             this.partialEsTs = 0;
//             this.lastBlockEsTs = Date.now();
//           }

//           const norm = (s: string) => s.toLowerCase().replace(/[.,?!¿¡]/g,'').replace(/\s+/g,' ').trim()
//             .replace(/keppra/gi, 'kepra').replace(/sí,?\s*/gi, 'si ').trim();
//           const normNew = norm(text);

//           // Buscar el último bloque del MISMO idioma
//           const lastSameIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               if (this.bloques[i].lang === lang) return i;
//             }
//             return -1;
//           })();

//           // También buscar el último bloque de CUALQUIER idioma que sea prefijo del nuevo texto
//           // (cubre el caso donde el bloque fue corregido a otro idioma por Claude)
//           const lastAnyIdx = (() => {
//             for (let i = this.bloques.length - 1; i >= 0; i--) {
//               const normPrev = norm(this.bloques[i].text);
//               const prefix = normPrev.substring(0, Math.min(normPrev.length, 15));
//               if (prefix.length >= 4 && normNew.startsWith(prefix) && normNew.length > normPrev.length) {
//                 return i;
//               }
//             }
//             return -1;
//           })();

//           const msSinceBlock = lang === 'en' ? Date.now() - this.lastBlockEnTs : Date.now() - this.lastBlockEsTs;

//           // Primero verificar extensión cross-idioma (bloque corregido a otro idioma)
//           if (lastAnyIdx >= 0 && msSinceBlock < 3000 && lastAnyIdx !== lastSameIdx) {
//             this.bloques[lastAnyIdx] = { text, lang };
//             console.log(`🔄 Bloque extendido [cross-lang→${lang}]:`, text.substring(0, 60));
//             this.render();
//             return;
//           }

//           if (lastSameIdx >= 0 && msSinceBlock < 3000) {
//             const normPrev = norm(this.bloques[lastSameIdx].text);
//             const isExtension = normNew.startsWith(normPrev.substring(0, Math.min(20, normPrev.length)))
//               && normNew.length > normPrev.length;
//             const isShortBackchannel = normNew.split(/\s+/).filter(Boolean).length <= 2;
//             const isDuplicate = !isShortBackchannel && (normNew === normPrev
//               || normPrev.startsWith(normNew.substring(0, Math.min(20, normNew.length))));
//             if (isExtension) {
//               this.bloques[lastSameIdx] = { text, lang };
//               console.log(`🔄 Bloque extendido [${lang}]:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//             if (isDuplicate) {
//               console.log(`🔇 Bloque duplicado [${lang}] ignorado:`, text.substring(0, 60));
//               this.render();
//               return;
//             }
//           }
//           this.bloques.push({ text, lang });
//           console.log(`✅ Bloque [${lang}]:`, text.substring(0, 60));
//           this.render();
//           return;
//         }

//         // ── PARTIAL: preview en vivo ────────────────────────────────────────
//         const now = Date.now();
//         const lastBlockTs = lang === 'en' ? this.lastBlockEnTs : this.lastBlockEsTs;
//         if (now - lastBlockTs < 400) {
//           console.log(`🔇 Partial [${lang}] ignorado (eco post-bloque):`, text.substring(0, 40));
//           return;
//         }

//         if (lang === 'en') {
//           const currentEn = this.partialEn.text;
//           if (!currentEn || text.length >= currentEn.length * 0.7 || text.length > currentEn.length) {
//             this.partialEn = { text, lang: 'en' };
//           }
//           this.partialEnTs = now;
//           if (this.partialEs.text && now - this.partialEsTs > 2500) {
//             this.partialEs = { text: '', lang: 'es' };
//           }
//         } else {
//           const currentEs = this.partialEs.text;
//           if (!currentEs || text.length >= currentEs.length * 0.7 || text.length > currentEs.length) {
//             this.partialEs = { text, lang: 'es' };
//           }
//           this.partialEsTs = now;
//           if (this.partialEn.text && now - this.partialEnTs > 2500) {
//             this.partialEn = { text: '', lang: 'en' };
//           }
//         }

//         console.log(`📝 Partial [${lang}]:`, text.substring(0, 50));
//         this.render();

//       } catch (e) {
//         console.error('❌ Error parsing partialTranscript:', e, dataStr);
//       }
//     });

//     this.socket.on('error', (err: any) => {
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });

//     this.socket.on('started', () => {
//       this.loading = false;
//     });

//     this.socket.on('stopped', () => {
//       if (this.partialEn.text.trim()) {
//         this.bloques.push({ ...this.partialEn });
//         this.partialEn = { text: '', lang: 'en' };
//       }
//       if (this.partialEs.text.trim()) {
//         this.bloques.push({ ...this.partialEs });
//         this.partialEs = { text: '', lang: 'es' };
//       }
//       this.render();
//     });
//   }

//   private render(): void {
//     const toShow: Bloque[] = [...this.bloques];
//     this.transcription = toShow
//       .filter(b => b.text.trim())
//       .map(b => b.text)
//       .join('\n\n');
//     this.cdr.detectChanges();
//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 50);
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   get activePartial(): Bloque | null {
//     const hasEn = this.partialEn.text.trim().length > 0;
//     const hasEs = this.partialEs.text.trim().length > 0;
//     if (!hasEn && !hasEs) return null;
//     if (hasEn && !hasEs) return this.partialEn;
//     if (!hasEn && hasEs) return this.partialEs;
//     return this.partialEn.text.length >= this.partialEs.text.length
//       ? this.partialEn : this.partialEs;
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();
//       this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.partialEn = { text: '', lang: 'en' };
//       this.partialEs = { text: '', lang: 'es' };
//       this.previousTranscriptionLength = 0;
//       this.loading = true;
//       this.translations = [];
//       this.startTimer();
//       this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });
//       this.socket.emit('startTranscription', { sessionId: this.sessionId });

//       if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//       this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
//         const uint8 = new Uint8Array(buffer);
//         this.socket.emit('audioChunk', { sessionId: this.sessionId, chunk: Array.from(uint8) });
//       });
//     } catch (err: any) {
//       this.loading = false;
//       this.isRecording = false;
//       this.stopTimer();
//       let msg = err.message || 'Error al iniciar captura.';
//       if (err.name === 'NotSupportedError') msg = 'Screen capture no soportado. Usa Chrome + HTTPS.';
//       if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio".';
//       if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona pestaña con audio.';
//       this.snackBar.open(msg, 'OK', { duration: 5000 });
//     }
//   }

//   stopRecording() {
//     this.socket.emit('stopTranscription', { sessionId: this.sessionId });
//     this.audioService.stopRecording();
//     this.isRecording = false;
//     this.loading = false;
//     this.stopTimer();
//     if (this.chunkSubscription) { this.chunkSubscription.unsubscribe(); this.chunkSubscription = null; }
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.bloques = [];
//     this.transcription = '';
//     this.translations = [];
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
//   }

//   clearTranscription() {
//     const wasEmpty = this.bloques.length === 0 && !this.partialEn.text && !this.partialEs.text;
//     this.transcription = '';
//     this.bloques = [];
//     this.partialEn = { text: '', lang: 'en' };
//     this.partialEs = { text: '', lang: 'es' };
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     if (!wasEmpty) this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
//   }

//   private startTimer(): void {
//     this.sessionStartTime = Date.now();
//     this.sessionDuration = '00:00:00';
//     this.timerInterval = setInterval(() => {
//       const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
//       const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
//       const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
//       const s = (elapsed % 60).toString().padStart(2, '0');
//       this.sessionDuration = `${h}:${m}:${s}`;
//       this.cdr.detectChanges();
//     }, 1000);
//   }

//   private stopTimer(): void {
//     if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
//     this.sessionDuration = '00:00:00';
//   }

//   private detectLanguageFrontend(text: string): 'es' | 'en' {
//     const t = text.toLowerCase().trim();
//     if (/[áéíóúñ¿¡]/i.test(t)) return 'es';
//     if (/^(sí|si|no|ya|yo|mi|tu|su|lo|la|le|un|al|del|eh|ay|fue|hay|hoy|más|nos|eso|ese|esa|con|por|que|muy|son|han|van|voy|soy|da|ir)$/.test(t)) return 'es';
//     if (/\b(de|del|el|la|los|las|un|una|está|son|es|por|para|con|pero|y|me|te|se|lo|le|sí|desde|hace|porque|cuando|tengo|tiene)\b/gi.test(t)) return 'es';
//     return 'en';
//   }

//   addTranslation(text: string): void {
//     const isSpanish = this.detectLanguageFrontend(text) === 'es';
//     const translation = {
//       original: text, translated: '',
//       sourceLang: isSpanish ? 'es' : 'en',
//       targetLang: isSpanish ? 'en' : 'es',
//       translating: true
//     };
//     this.translations.unshift(translation);
//     this.translateItem(translation);
//   }

//   async translateItem(translation: any): Promise<void> {
//     try {
//       const textToTranslate = translation.original.length > 500
//         ? translation.original.substring(0, 500) + '...'
//         : translation.original;
//       let translated = '';
//       let success = false;

//       try {
//         const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${translation.sourceLang}|${translation.targetLang}`;
//         const response = await fetch(url);
//         if (response.ok) {
//           const data = await response.json();
//           if (data.responseStatus === 200 && data.responseData?.translatedText) {
//             const t = data.responseData.translatedText;
//             if (t && t !== textToTranslate && !t.toLowerCase().includes('mymemory')) { translated = t; success = true; }
//           }
//         }
//       } catch { }

//       if (!success) {
//         try {
//           const url = `https://lingva.ml/api/v1/${translation.sourceLang}/${translation.targetLang}/${encodeURIComponent(textToTranslate)}`;
//           const response = await fetch(url);
//           if (response.ok) { const data = await response.json(); if (data.translation) { translated = data.translation; success = true; } }
//         } catch { }
//       }

//       translation.translated = success && translated ? translated : '⚠️ Traducción no disponible';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     } catch {
//       translation.translated = '⚠️ Error al traducir';
//       translation.translating = false;
//       this.cdr.detectChanges();
//     }
//   }

//   onTextSelection(): void {
//     const selection = window.getSelection();
//     const selectedText = selection?.toString().trim();
//     if (selectedText && selectedText.length > 0) {
//       const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
//       if (selectedText.length > 500) this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
//       this.addTranslation(textToTranslate);
//       selection?.removeAllRanges();
//     }
//   }

//   removeTranslation(index: number): void { this.translations.splice(index, 1); }
//   clearAllTranslations(): void { this.translations = []; }
//   toggleTranslationPanel(): void {}
//   async translateSelection(): Promise<void> {}
//   closeTranslation(): void {}

//   ngAfterViewChecked(): void {
//     if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
//   }

//   ngOnDestroy() {
//     this.stopTimer();
//     if (this.chunkSubscription) this.chunkSubscription.unsubscribe();
//     this.socket.disconnect();
//   }

//   private scrollToBottom(): void {
//     if (this.scrollMe && this.autoScrollEnabled) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
//     }
//   }

//   private isAtBottom(): boolean {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       return el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
//     }
//     return false;
//   }

//   onContainerScroll(): void {
//     this.autoScrollEnabled = this.isAtBottom();
//   }
// }