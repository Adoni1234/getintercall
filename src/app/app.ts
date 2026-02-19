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

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatIconModule
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App implements AfterViewChecked, OnDestroy {
  title = 'GetIntercall';
  isRecording = false;
  transcription = '';
  loading = false;

  @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

  private socket: Socket;
  private sessionId = '';

  private audioService = inject(AudioService);
  private cdr = inject(ChangeDetectorRef);
  private snackBar = inject(MatSnackBar);

  public currentPartial: { text: string; lang: string } = { text: '', lang: '' };
  bloques: { text: string; lang: string }[] = [];

  // Panel fijo — siempre visible
  showTranslationPanel = true;

  translations: Array<{
    original: string;
    translated: string;
    sourceLang: string;
    targetLang: string;
    translating: boolean;
  }> = [];

  private silenceTimer: any = null;

  // ── Agrupación de bloques ─────────────────────────────────────────────────
  // 5000ms: espera 5 segundos de silencio antes de cerrar un bloque.
  // Antes era 2500ms — demasiado corto para pausas naturales en llamadas.
  // El backend tiene FORCE_CLOSE_AFTER_MS=1800ms para is_final de AssemblyAI,
  // pero el frontend solo cierra si el backend no envió nada en 5s completos.
  private readonly SILENCE_TIMEOUT_MS = 5000;

  private lastPartialTime = 0;
  private previousTranscriptionLength = 0;
  autoScrollEnabled = true;
  private chunkSubscription: Subscription | null = null;

  constructor() {
    this.socket = io(environment.apiUrl);

    this.socket.on('connect', () => {
      console.log('✅ Socket conectado a backend!');
    });

    this.socket.on('disconnect', () => {
      console.log('⚠️ Socket desconectado');
    });

    this.socket.on('partialTranscript', (dataStr: string) => {
      try {
        const data = JSON.parse(dataStr);

        if (data.sessionId !== this.sessionId) return;
        if (!data.text?.trim()) return;

        const newText = data.text.trim();
        const detectedLang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

        this.lastPartialTime = Date.now();

        if (data.isNewTurn) {
          // BLOQUE DEFINITIVO — fusionar con el último bloque si es del mismo idioma
          // y llegó hace menos de 3 segundos (pausa breve entre frases)
          this.currentPartial = { text: '', lang: '' };

          const lastBlock = this.bloques[this.bloques.length - 1];
          const timeSinceLastBlock = Date.now() - (this as any)._lastBlockTime;
          const shouldMerge = lastBlock && timeSinceLastBlock < 8000;

          if (shouldMerge) {
            // Fusionar con el bloque anterior en lugar de crear uno nuevo
            lastBlock.text += ' ' + newText;
            console.log(`🔗 FUSIONADO con bloque anterior [${detectedLang}]: "${newText.substring(0, 60)}"`);
          } else {
            this.bloques.push({ text: newText, lang: detectedLang });
            console.log(`✅ BLOQUE FINAL #${this.bloques.length} [${detectedLang}]: "${newText.substring(0, 80)}"`);
          }
          (this as any)._lastBlockTime = Date.now();

        } else if (data.isNewBlock) {
          this.currentPartial = { text: newText, lang: detectedLang };
          console.log(`🆕 NUEVO BLOQUE [${detectedLang}]: "${newText.substring(0, 60)}"`);

        } else {
          // PARTIAL — acumular
          if (this.currentPartial.text) {
            this.currentPartial.text += ' ' + newText;
            const wordCount = this.currentPartial.text.split(/\s+/).filter(Boolean).length;
            if (wordCount < 5) {
              this.currentPartial.lang = detectedLang;
            }
          } else {
            this.currentPartial = { text: newText, lang: detectedLang };
          }
          console.log(`📝 PARTIAL [${detectedLang}]: "${this.currentPartial.text.substring(0, 80)}"`);
        }

        this.updateTranscription();

      } catch (e) {
        console.error('❌ Error parsing partialTranscript:', e, dataStr);
      }
    });

    this.socket.on('error', (err: any) => {
      console.error('❌ WS error:', err);
      this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
    });

    this.socket.on('started', (data: any) => {
      console.log('✅ Real-time iniciado para session', data.sessionId);
      this.loading = false;
      this.startSilenceTimer();
    });

    this.socket.on('stopped', (data: any) => {
      console.log('🛑 Real-time detenido para session', data.sessionId);
      this.stopSilenceTimer();
      if (this.currentPartial.text.trim()) {
        this.bloques.push({ ...this.currentPartial });
        this.currentPartial = { text: '', lang: '' };
        this.updateTranscription();
      }
    });
  }

  private startSilenceTimer(): void {
    (this as any)._lastBlockTime = Date.now();
    this.silenceTimer = setInterval(() => {
      if (!this.isRecording) return;
      if (!this.currentPartial.text.trim()) return;

      const elapsed = Date.now() - this.lastPartialTime;
      if (elapsed > this.SILENCE_TIMEOUT_MS) {
        console.log(`⏱️ Frontend silence timer: cerrando bloque tras ${elapsed}ms`);
        this.bloques.push({ ...this.currentPartial });
        (this as any)._lastBlockTime = Date.now();
        this.currentPartial = { text: '', lang: '' };
        this.lastPartialTime = Date.now();
        this.updateTranscription();
      }
    }, 500);
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private updateTranscription(): void {
    const allBlocks = [...this.bloques];
    if (this.currentPartial.text.trim()) allBlocks.push(this.currentPartial);

    this.transcription = allBlocks
      .filter(b => b.text.trim())
      .map(b => b.text)
      .join('\n\n');

    this.cdr.detectChanges();

    if (this.transcription.length > this.previousTranscriptionLength) {
      setTimeout(() => this.scrollToBottom(), 100);
      this.previousTranscriptionLength = this.transcription.length;
    }
  }

  async startRecording() {
    try {
      await this.audioService.startTabAudioCapture();

      this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      console.log('🆔 Nueva sesión:', this.sessionId);

      this.isRecording = true;
      this.transcription = '';
      this.bloques = [];
      this.currentPartial = { text: '', lang: '' };
      this.lastPartialTime = Date.now();
      this.previousTranscriptionLength = 0;
      (this as any)._lastBlockTime = Date.now();
      this.loading = true;

      this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });

      this.socket.emit('startTranscription', { sessionId: this.sessionId });
      console.log('📤 startTranscription emitido para session', this.sessionId);

      if (this.chunkSubscription) {
        this.chunkSubscription.unsubscribe();
        this.chunkSubscription = null;
      }

      this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
        const uint8 = new Uint8Array(buffer);
        this.socket.emit('audioChunk', {
          sessionId: this.sessionId,
          chunk: Array.from(uint8)
        });
      });

    } catch (err: any) {
      console.error('❌ Error:', err);
      this.loading = false;
      this.isRecording = false;
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
    this.stopSilenceTimer();

    if (this.chunkSubscription) {
      this.chunkSubscription.unsubscribe();
      this.chunkSubscription = null;
    }

    this.clearTranscription();
    this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
  }

  clearTranscription() {
    const wasEmpty = this.bloques.length === 0 && !this.currentPartial.text.trim();
    this.transcription = '';
    this.bloques = [];
    this.currentPartial = { text: '', lang: '' };
    this.previousTranscriptionLength = 0;
    this.cdr.detectChanges();
    if (!wasEmpty) {
      this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
    }
  }

  private detectLanguageFrontend(text: string): 'es' | 'en' {
    const cleanText = text.toLowerCase().trim();
    if (/[áéíóúñ¿¡]/i.test(cleanText)) return 'es';
    const spanishPattern = /\b(de|del|el|la|los|las|un|una|está|están|son|es|como|qué|cómo|por|para|con|sin|pero|y|o|mi|tu|su|me|te|se|lo|le|ha|he|sido|sé|vamos|hacer|entonces|solo|más|nada|esto|no|que|muy|aquí|allí|bien|mal|todo|siempre|nunca|cuando|donde|mucho|poco|grande|nuevo|bueno|malo|si|sí|ver|ir|voy|va|hago|dice|ser|estar|tener|tengo|tiene|poder|puedo|querer|quiero|deber|debe|año|día|vez|cosa|gente|tiempo|vida|casa|ciudad|desde|hasta|otro|mismo|cada|todos|estamos)\b/gi;
    const words = cleanText.split(/\s+/).filter(w => w.length > 0);
    const spanishMatches = cleanText.match(spanishPattern);
    const spanishWordCount = spanishMatches ? spanishMatches.length : 0;
    const spanishRatio = words.length > 0 ? spanishWordCount / words.length : 0;
    if (words.length <= 5 && spanishWordCount >= 1) return 'es';
    if (spanishRatio >= 0.18) return 'es';
    return 'en';
  }

  addTranslation(text: string): void {
    const isSpanish = this.detectLanguageFrontend(text) === 'es';
    const translation = {
      original: text,
      translated: '',
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

      try {
        const response = await fetch('https://libretranslate.com/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: textToTranslate,
            source: translation.sourceLang,
            target: translation.targetLang,
            format: 'text'
          })
        });
        if (response.ok) {
          const data = await response.json();
          translated = data.translatedText;
        } else throw new Error('LibreTranslate failed');
      } catch {
        const langPair = `${translation.sourceLang}|${translation.targetLang}`;
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${langPair}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('MyMemory failed');
        const data = await response.json();
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          translated = data.responseData.translatedText;
        } else throw new Error('MyMemory invalid response');
      }

      translation.translated = translated;
      translation.translating = false;
      this.cdr.detectChanges();
    } catch (error) {
      console.error('❌ Translation error:', error);
      translation.translated = 'Error: Servicio de traducción no disponible';
      translation.translating = false;
      this.cdr.detectChanges();
      this.snackBar.open('⚠️ Error al traducir.', 'OK', { duration: 3000 });
    }
  }

  onTextSelection(): void {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (selectedText && selectedText.length > 0) {
      const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
      if (selectedText.length > 500) {
        this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
      }
      this.addTranslation(textToTranslate);
      selection?.removeAllRanges();
    }
  }

  removeTranslation(index: number): void { this.translations.splice(index, 1); }

  clearAllTranslations(): void {
    this.translations = [];
    this.snackBar.open('🧹 Traducciones limpiadas', 'OK', { duration: 1500 });
  }

  // Mantenido por compatibilidad pero no usado — panel siempre visible
  toggleTranslationPanel(): void {}
  async translateSelection(): Promise<void> {}
  closeTranslation(): void {}

  ngAfterViewChecked(): void {
    if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
  }

  ngOnDestroy() {
    this.stopSilenceTimer();
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

  onContainerScroll(event: Event): void {
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

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [
//     CommonModule,
//     MatCardModule,
//     MatButtonModule,
//     MatSnackBarModule,
//     MatProgressSpinnerModule,
//     MatIconModule
//   ],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked, OnDestroy {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private socket: Socket;

//   // ✅ sessionId se regenera en cada startRecording() para evitar colisiones
//   // entre sesiones del mismo usuario o múltiples intérpretes simultáneos
//   private sessionId = '';

//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);

//   public currentPartial: { text: string; lang: string } = { text: '', lang: '' };
//   bloques: { text: string; lang: string }[] = [];

//   showTranslationPanel = true;
//   translations: Array<{
//     original: string;
//     translated: string;
//     sourceLang: string;
//     targetLang: string;
//     translating: boolean;
//   }> = [];

//   private silenceTimer: any = null;

//   // Timer de seguridad en frontend: si pasan 2.5s sin partials, cerrar bloque
//   // Debe estar alineado con FORCE_CLOSE_AFTER_MS del backend
//   private readonly SILENCE_TIMEOUT_MS = 2500;

//   private lastPartialTime = 0;
//   private previousTranscriptionLength = 0;
//   autoScrollEnabled = true;
//   private chunkSubscription: Subscription | null = null;

//   constructor() {
//     this.socket = io(environment.apiUrl);

//     this.socket.on('connect', () => {
//       console.log('✅ Socket conectado a backend!');
//     });

//     this.socket.on('disconnect', () => {
//       console.log('⚠️ Socket desconectado');
//     });

//     this.socket.on('partialTranscript', (dataStr: string) => {
//       try {
//         const data = JSON.parse(dataStr);

//         // Ignorar mensajes de otras sesiones (importante con sessionId único)
//         if (data.sessionId !== this.sessionId) return;
//         if (!data.text?.trim()) return;

//         const newText = data.text.trim();
//         const detectedLang: 'es' | 'en' = data.language === 'es' ? 'es' : 'en';

//         this.lastPartialTime = Date.now();

//         if (data.isNewTurn) {
//           // ── BLOQUE DEFINITIVO ────────────────────────────────────────────
//           // El backend envía el texto COMPLETO del turno finalizado.
//           // Descartamos el partial acumulado en frontend (el backend ya lo tiene correcto).
//           this.currentPartial = { text: '', lang: '' };
//           this.bloques.push({ text: newText, lang: detectedLang });
//           console.log(`✅ BLOQUE FINAL #${this.bloques.length} [${detectedLang}]: "${newText.substring(0, 80)}"`);

//         } else if (data.isNewBlock) {
//           // ── NUEVO BLOQUE tras reformulación de AssemblyAI ────────────────
//           // El backend ya cerró el bloque anterior. Iniciar uno nuevo.
//           this.currentPartial = { text: newText, lang: detectedLang };
//           console.log(`🆕 NUEVO BLOQUE [${detectedLang}]: "${newText.substring(0, 60)}"`);

//         } else {
//           // ── PARTIAL: Acumular en el bloque actual ────────────────────────
//           if (this.currentPartial.text) {
//             this.currentPartial.text += ' ' + newText;
//             // Corregir idioma en los primeros tokens (AssemblyAI puede tardar en detectar)
//             const wordCount = this.currentPartial.text.split(/\s+/).filter(Boolean).length;
//             if (wordCount < 5) {
//               this.currentPartial.lang = detectedLang;
//             }
//           } else {
//             this.currentPartial = { text: newText, lang: detectedLang };
//           }
//           console.log(`📝 PARTIAL [${detectedLang}]: "${this.currentPartial.text.substring(0, 80)}"`);
//         }

//         this.updateTranscription();

//       } catch (e) {
//         console.error('❌ Error parsing partialTranscript:', e, dataStr);
//       }
//     });

//     this.socket.on('error', (err: any) => {
//       console.error('❌ WS error:', err);
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });

//     this.socket.on('started', (data: any) => {
//       console.log('✅ Real-time iniciado para session', data.sessionId);
//       this.loading = false;
//       this.startSilenceTimer();
//     });

//     this.socket.on('stopped', (data: any) => {
//       console.log('🛑 Real-time detenido para session', data.sessionId);
//       this.stopSilenceTimer();
//       // Finalizar partial pendiente si quedó algo
//       if (this.currentPartial.text.trim()) {
//         this.bloques.push({ ...this.currentPartial });
//         this.currentPartial = { text: '', lang: '' };
//         this.updateTranscription();
//       }
//     });
//   }

//   // Timer de seguridad en frontend: tercer nivel de cierre de bloques
//   private startSilenceTimer(): void {
//     this.silenceTimer = setInterval(() => {
//       if (!this.isRecording) return;
//       if (!this.currentPartial.text.trim()) return;

//       const elapsed = Date.now() - this.lastPartialTime;
//       if (elapsed > this.SILENCE_TIMEOUT_MS) {
//         console.log(`⏱️ Frontend silence timer: cerrando bloque tras ${elapsed}ms`);
//         this.bloques.push({ ...this.currentPartial });
//         this.currentPartial = { text: '', lang: '' };
//         this.lastPartialTime = Date.now();
//         this.updateTranscription();
//       }
//     }, 300);
//   }

//   private stopSilenceTimer(): void {
//     if (this.silenceTimer) {
//       clearInterval(this.silenceTimer);
//       this.silenceTimer = null;
//     }
//   }

//   private updateTranscription(): void {
//     const allBlocks = [...this.bloques];
//     if (this.currentPartial.text.trim()) allBlocks.push(this.currentPartial);

//     this.transcription = allBlocks
//       .filter(b => b.text.trim())
//       .map(b => `[${b.lang.toUpperCase()}] ${b.text}`)
//       .join('\n\n');

//     this.cdr.detectChanges();

//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 100);
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();

//       // ✅ Nuevo sessionId en cada grabación — evita colisiones entre sesiones
//       this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
//       console.log('🆔 Nueva sesión:', this.sessionId);

//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.currentPartial = { text: '', lang: '' };
//       this.lastPartialTime = Date.now();
//       this.previousTranscriptionLength = 0;
//       this.loading = true;

//       this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });

//       this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       console.log('📤 startTranscription emitido para session', this.sessionId);

//       // Cancelar suscripción anterior y resuscribirse al nuevo chunk$
//       if (this.chunkSubscription) {
//         this.chunkSubscription.unsubscribe();
//         this.chunkSubscription = null;
//       }

//       this.chunkSubscription = this.audioService.chunk$.subscribe((buffer: ArrayBuffer) => {
//         const uint8 = new Uint8Array(buffer);
//         this.socket.emit('audioChunk', {
//           sessionId: this.sessionId,
//           chunk: Array.from(uint8)
//         });
//       });

//     } catch (err: any) {
//       console.error('❌ Error:', err);
//       this.loading = false;
//       this.isRecording = false;
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
//     this.stopSilenceTimer();

//     if (this.chunkSubscription) {
//       this.chunkSubscription.unsubscribe();
//       this.chunkSubscription = null;
//     }

//     this.clearTranscription();
//     this.snackBar.open('🛑 Transcripción detenida.', 'OK', { duration: 2000 });
//   }

//   clearTranscription() {
//     const wasEmpty = this.bloques.length === 0 && !this.currentPartial.text.trim();
//     this.transcription = '';
//     this.bloques = [];
//     this.currentPartial = { text: '', lang: '' };
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
//     if (!wasEmpty) {
//       this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
//     }
//   }

//   // ── Detección de idioma (fallback si backend no envía language) ──────────
//   private detectLanguageFrontend(text: string): 'es' | 'en' {
//     const cleanText = text.toLowerCase().trim();
//     if (/[áéíóúñ¿¡]/i.test(cleanText)) return 'es';
//     const spanishPattern = /\b(de|del|el|la|los|las|un|una|está|están|son|es|como|qué|cómo|por|para|con|sin|pero|y|o|mi|tu|su|me|te|se|lo|le|ha|he|sido|sé|vamos|hacer|entonces|solo|más|nada|esto|no|que|muy|aquí|allí|bien|mal|todo|siempre|nunca|cuando|donde|mucho|poco|grande|nuevo|bueno|malo|si|sí|ver|ir|voy|va|hago|dice|ser|estar|tener|tengo|tiene|poder|puedo|querer|quiero|deber|debe|año|día|vez|cosa|gente|tiempo|vida|casa|ciudad|desde|hasta|otro|mismo|cada|todos|estamos)\b/gi;
//     const words = cleanText.split(/\s+/).filter(w => w.length > 0);
//     const spanishMatches = cleanText.match(spanishPattern);
//     const spanishWordCount = spanishMatches ? spanishMatches.length : 0;
//     const spanishRatio = words.length > 0 ? spanishWordCount / words.length : 0;
//     if (words.length <= 5 && spanishWordCount >= 1) return 'es';
//     if (spanishRatio >= 0.18) return 'es';
//     return 'en';
//   }

//   // ── Traducciones ─────────────────────────────────────────────────────────
//   addTranslation(text: string): void {
//     const isSpanish = this.detectLanguageFrontend(text) === 'es';
//     const translation = {
//       original: text,
//       translated: '',
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

//       try {
//         const response = await fetch('https://libretranslate.com/translate', {
//           method: 'POST',
//           headers: { 'Content-Type': 'application/json' },
//           body: JSON.stringify({
//             q: textToTranslate,
//             source: translation.sourceLang,
//             target: translation.targetLang,
//             format: 'text'
//           })
//         });
//         if (response.ok) {
//           const data = await response.json();
//           translated = data.translatedText;
//         } else throw new Error('LibreTranslate failed');
//       } catch {
//         const langPair = `${translation.sourceLang}|${translation.targetLang}`;
//         const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${langPair}`;
//         const response = await fetch(url);
//         if (!response.ok) throw new Error('MyMemory failed');
//         const data = await response.json();
//         if (data.responseStatus === 200 && data.responseData?.translatedText) {
//           translated = data.responseData.translatedText;
//         } else throw new Error('MyMemory invalid response');
//       }

//       translation.translated = translated;
//       translation.translating = false;
//       this.cdr.detectChanges();
//     } catch (error) {
//       console.error('❌ Translation error:', error);
//       translation.translated = 'Error: Servicio de traducción no disponible';
//       translation.translating = false;
//       this.cdr.detectChanges();
//       this.snackBar.open('⚠️ Error al traducir.', 'OK', { duration: 3000 });
//     }
//   }

//   onTextSelection(): void {
//     const selection = window.getSelection();
//     const selectedText = selection?.toString().trim();
//     if (selectedText && selectedText.length > 0) {
//       const textToTranslate = selectedText.length > 500 ? selectedText.substring(0, 500) : selectedText;
//       if (selectedText.length > 500) {
//         this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
//       }
//       this.addTranslation(textToTranslate);
//       selection?.removeAllRanges();
//     }
//   }

//   removeTranslation(index: number): void { this.translations.splice(index, 1); }
//   clearAllTranslations(): void {
//     this.translations = [];
//     this.snackBar.open('🧹 Traducciones limpiadas', 'OK', { duration: 1500 });
//   }
//   toggleTranslationPanel(): void { this.showTranslationPanel = !this.showTranslationPanel; }
//   async translateSelection(): Promise<void> {}
//   closeTranslation(): void {}

//   // ── Scroll ───────────────────────────────────────────────────────────────
//   ngAfterViewChecked(): void {
//     if (this.transcription && this.autoScrollEnabled) this.scrollToBottom();
//   }

//   ngOnDestroy() {
//     this.stopSilenceTimer();
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

//   onContainerScroll(event: Event): void {
//     this.autoScrollEnabled = this.isAtBottom();
//   }
// }
