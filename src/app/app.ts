import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AudioService } from './services/audio-service';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { io, Socket } from 'socket.io-client';
import { environment } from '../environments/environment';

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
export class App implements AfterViewChecked {
  title = 'GetIntercall';
  isRecording = false;
  transcription = '';
  loading = false;

  @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

  private destroyRef = inject(DestroyRef);
  private socket: Socket;
  private sessionId = Date.now().toString();
  private audioService = inject(AudioService);
  private cdr = inject(ChangeDetectorRef);
  private snackBar = inject(MatSnackBar);
  
  public currentPartial: { text: string; lang: string } = { text: '', lang: '' };
  bloques: { text: string; lang: string }[] = [];

  // Translation feature - Panel lateral
  showTranslationPanel = true;
  translations: Array<{
    original: string;
    translated: string;
    sourceLang: string;
    targetLang: string;
    translating: boolean;
  }> = [];

  private silenceTimer: any;
  private lastPartialTime = 0;
  private silenceTimeout = 1500; // 1.5s sin partials → finalizar bloque
  private previousTranscriptionLength = 0;
  autoScrollEnabled = true;

  constructor() {
    this.socket = io(environment.apiUrl);
    
    this.socket.on('connect', () => {
      console.log('✅ Socket conectado a backend!');
    });

    this.socket.on('partialTranscript', (dataStr: string) => {
      console.log('📥 Frontend recibido partialTranscript:', dataStr.substring(0, 100));
      try {
        const data = JSON.parse(dataStr);
        if (data.sessionId === this.sessionId && data.text.trim()) {
          const newText = data.text.trim();
          
          // 🔥 PRIORIDAD: Usar idioma del BACKEND (ya detectado correctamente)
          let detectedLang: 'es' | 'en' = 'en';
          
          if (data.language) {
            // Backend envía 'language' (no 'lang')
            detectedLang = data.language === 'es' ? 'es' : 'en';
            console.log(`✅ Backend language: ${data.language} → ${detectedLang}`);
          } else {
            // Fallback: detección frontend (por si backend falla)
            detectedLang = this.detectLanguageFrontend(newText);
            console.log(`⚠️ Backend no envió idioma, detectado en frontend: ${detectedLang}`);
          }
          
          this.lastPartialTime = Date.now();

          // Check for LANGUAGE CHANGE
          const currentWordCount = this.currentPartial.text.split(/\s+/).filter(w => w).length;
          const languageChanged = this.currentPartial.text.trim() && 
                                  currentWordCount >= 3 && 
                                  this.currentPartial.lang !== detectedLang;

          if (data.isNewTurn) {
            // FINAL from backend: Finalize current partial block
            if (this.currentPartial.text.trim()) {
              this.bloques.push({ ...this.currentPartial });
              console.log(`✅ FINALIZED bloque #${this.bloques.length} [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 50)}..."`);
            }
            this.currentPartial = { text: newText, lang: detectedLang };
            console.log(`🆕 NEW TURN started with [${detectedLang}]: "${newText.substring(0, 50)}..."`);
          } else if (languageChanged) {
            // Language switched! Finalize current block and start new one
            this.bloques.push({ ...this.currentPartial });
            console.log(`🌐 LANGUAGE CHANGE! Finalized [${this.currentPartial.lang}] bloque #${this.bloques.length} (${currentWordCount} words), starting [${detectedLang}] bloque`);
            this.currentPartial = { text: newText, lang: detectedLang };
          } else {
            // PARTIAL: APPEND new text to current partial
            if (this.currentPartial.text) {
              this.currentPartial.text += ' ' + newText;
              // Update language for first 3 words to allow early correction
              if (currentWordCount < 3) {
                this.currentPartial.lang = detectedLang;
                console.log(`🔄 Early lang update to [${detectedLang}] at ${currentWordCount} words`);
              }
            } else {
              this.currentPartial.text = newText;
              this.currentPartial.lang = detectedLang;
            }
            console.log(`📝 APPENDED [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 60)}..." (${this.currentPartial.text.split(/\s+/).filter(w => w).length} words)`);
          }
          
          this.updateTranscription();
        }
      } catch (e) {
        console.error('❌ Error parsing partial:', e, dataStr);
      }
    });

    this.socket.on('error', (err) => {
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
        console.log(`✅ Finalizado parcial en stop: "${this.currentPartial.text.substring(0, 50)}..."`);
        this.currentPartial = { text: '', lang: '' };
        this.updateTranscription();
      }
    });

    this.socket.on('chunkReceived', (data: any) => {
      console.log('📦 Chunk recibido en backend:', data.size, 'bytes');
    });
  }

  // 🔥 FUNCIÓN DE DETECCIÓN FRONTEND (Fallback mejorado)
  private detectLanguageFrontend(text: string): 'es' | 'en' {
    const cleanText = text.toLowerCase().trim();
    
    // 1. Caracteres españoles = automáticamente español
    if (/[áéíóúñ¿¡]/i.test(cleanText)) {
      console.log('🎯 Frontend: Spanish chars detected');
      return 'es';
    }
    
    // 2. Patrones gramaticales españoles
    const spanishGrammarPatterns = [
      /\b(que|qué)\s+(es|son|está|están|tiene|tienen)\b/i,
      /\b(el|la|los|las)\s+\w+\s+(de|del)\b/i,
      /\b(esto|esta|este|eso|esa|ese)\s+(es|son)\b/i,
      /\b(muy|más|menos)\s+\w+/i,
      /\b(no|si)\s+(puedo|puede|quiero|quiere|voy|va)\b/i,
      /\baquí\s+(es|está|en)\b/i,
      /\bestamos\s+(con|en)\b/i,
    ];
    
    if (spanishGrammarPatterns.some(pattern => pattern.test(cleanText))) {
      console.log('🎯 Frontend: Spanish grammar detected');
      return 'es';
    }
    
    // 3. Palabras españolas expandidas
    const spanishPattern = /\b(de|del|el|la|los|las|un|una|está|están|son|es|como|qué|cómo|por|para|con|sin|pero|y|o|mi|tu|su|me|te|se|lo|le|ha|he|sido|sé|vamos|hacer|entonces|solo|mientras|lugares|más|nada|esto|no|que|muy|aquí|allí|bien|mal|todo|siempre|nunca|cuando|donde|mucho|poco|grande|nuevo|bueno|malo|si|sí|ver|vea|veía|ir|voy|va|hacer|hago|dice|decir|ser|estar|tener|tengo|tiene|poder|puedo|querer|deber|debe|año|día|vez|cosa|gente|tiempo|vida|casa|ciudad|centro|corazón|velada|desde|hasta|otro|mismo|cada|todos|sufro|huevo|viéndome|estamos|sea|medellín|raro|querer)\b/gi;
    
    const words = cleanText.split(/\s+/).filter(w => w.length > 0);
    const spanishMatches = cleanText.match(spanishPattern);
    const spanishWordCount = spanishMatches ? spanishMatches.length : 0;
    const spanishRatio = spanishWordCount / words.length;
    
    // Frases cortas: 1+ palabra española = español
    if (words.length <= 5 && spanishWordCount >= 1) {
      console.log(`🎯 Frontend: Short phrase ${spanishWordCount}/${words.length} Spanish`);
      return 'es';
    }
    
    // Frases largas: 18%+ español
    if (spanishRatio >= 0.18) {
      console.log(`🎯 Frontend: Spanish ratio ${(spanishRatio * 100).toFixed(1)}%`);
      return 'es';
    }
    
    console.log(`🔍 Frontend: Defaulting to English (${spanishWordCount}/${words.length})`);
    return 'en';
  }

  private startSilenceTimer(): void {
    this.silenceTimer = setInterval(() => {
      if (this.isRecording && this.currentPartial.text.trim() && 
          (Date.now() - this.lastPartialTime > this.silenceTimeout)) {
        // Silence detected: Finalize current partial
        this.bloques.push({ ...this.currentPartial });
        console.log(`⏱️ SILENCE FINALIZED bloque #${this.bloques.length} [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 50)}..."`);
        this.currentPartial = { text: '', lang: '' };
        this.lastPartialTime = Date.now();
        this.updateTranscription();
      }
    }, 250);
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private updateTranscription(): void {
    // Combine bloques + current partial for display
    const allBlocks = [...this.bloques];
    if (this.currentPartial.text.trim()) {
      allBlocks.push(this.currentPartial);
    }
    
    this.transcription = allBlocks
      .filter(b => b.text.trim())
      .map(b => `[${b.lang.toUpperCase()}] ${b.text}`)
      .join('\n\n');
    
    console.log(`🔄 UI updated (bloques finalizados: ${this.bloques.length}, parcial activo: ${this.currentPartial.text.length} chars)`);
    this.cdr.detectChanges();
    
    // Auto-scroll if content grew
    if (this.transcription.length > this.previousTranscriptionLength) {
      setTimeout(() => this.scrollToBottom(), 100);
      this.previousTranscriptionLength = this.transcription.length;
    }
  }

  async startRecording() {
    try {
      await this.audioService.startTabAudioCapture();

      this.isRecording = true;
      this.transcription = '';
      this.bloques = [];
      this.currentPartial = { text: '', lang: '' };
      this.lastPartialTime = Date.now();
      this.previousTranscriptionLength = 0;
      this.loading = true;

      this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });

      this.socket.emit('startTranscription', { sessionId: this.sessionId });
      console.log('📤 Emitido startTranscription para session', this.sessionId);

      this.audioService.chunk$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((blob: Blob) => {
          console.log('📦 Chunk listo para enviar:', blob.size, 'bytes');
          blob.arrayBuffer().then(buffer => {
            const uint8 = new Uint8Array(buffer);
            this.socket.emit('audioChunk', { 
              sessionId: this.sessionId, 
              chunk: Array.from(uint8)
            });
          });
        });

    } catch (err: any) {
      console.error('❌ Error completo:', err);
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
    
    // Clear all transcription data on stop
    this.clearTranscription();
    
    this.snackBar.open('🛑 Transcripción detenida y limpiada.', 'OK', { duration: 2000 });
  }

  clearTranscription() {
    const wasEmpty = this.bloques.length === 0 && !this.currentPartial.text.trim();
    
    this.transcription = '';
    this.bloques = [];
    this.currentPartial = { text: '', lang: '' };
    this.previousTranscriptionLength = 0;
    this.cdr.detectChanges();
    
    if (!wasEmpty) {
      console.log('🧹 Transcription cleared');
      this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
    }
  }

  ngAfterViewChecked(): void {
    if (this.transcription && this.autoScrollEnabled) {
      this.scrollToBottom();
    }
  }

  ngOnDestroy() {
    this.stopSilenceTimer();
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
    const atBottom = this.isAtBottom();
    if (!atBottom) {
      this.autoScrollEnabled = false;
      console.log('👤 User scrolled up: Auto-scroll disabled');
    } else {
      this.autoScrollEnabled = true;
      console.log('👤 User at bottom: Auto-scroll re-enabled');
    }
  }

  onTextSelection(): void {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    
    if (selectedText && selectedText.length > 0) {
      // Limit selection to 500 characters
      const textToTranslate = selectedText.length > 500 
        ? selectedText.substring(0, 500) 
        : selectedText;
      
      if (selectedText.length > 500) {
        this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
      }
      
      console.log(`📝 Text selected (${textToTranslate.length} chars): "${textToTranslate.substring(0, 30)}..."`);
      
      // Add to translations panel and translate immediately
      this.addTranslation(textToTranslate);
      
      // Clear selection
      selection?.removeAllRanges();
    }
  }

  addTranslation(text: string): void {
    // Detectar idioma para traducción usando función frontend
    const isSpanish = this.detectLanguageFrontend(text) === 'es';
    const sourceLang = isSpanish ? 'es' : 'en';
    const targetLang = isSpanish ? 'en' : 'es';
    
    console.log(`📊 Translation detection: ${sourceLang} → ${targetLang}`);
    
    // Add to beginning of array (most recent first)
    const translation = {
      original: text,
      translated: '',
      sourceLang,
      targetLang,
      translating: true
    };
    
    this.translations.unshift(translation);
    
    // Auto-translate
    this.translateItem(translation);
  }

  async translateItem(translation: any): Promise<void> {
    try {
      console.log(`🌐 Translating from ${translation.sourceLang} to ${translation.targetLang}: "${translation.original.substring(0, 30)}..."`);
      
      // Truncate text if too long (max 500 chars for free APIs)
      const textToTranslate = translation.original.length > 500 
        ? translation.original.substring(0, 500) + '...' 
        : translation.original;
      
      let translated = '';
      
      // Try LibreTranslate first
      try {
        const response = await fetch('https://libretranslate.com/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
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
        } else {
          throw new Error('LibreTranslate failed');
        }
      } catch (libreError) {
        console.warn('LibreTranslate failed, trying MyMemory API...', libreError);
        
        // Fallback to MyMemory API (no limits, free)
        const langPair = `${translation.sourceLang}|${translation.targetLang}`;
        const myMemoryUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${langPair}`;
        
        const response = await fetch(myMemoryUrl);
        
        if (!response.ok) {
          throw new Error('MyMemory API failed');
        }
        
        const data = await response.json();
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          translated = data.responseData.translatedText;
        } else {
          throw new Error('MyMemory returned invalid data');
        }
      }
      
      translation.translated = translated;
      translation.translating = false;
      
      console.log(`✅ Translation: "${translation.translated.substring(0, 50)}..."`);
      this.cdr.detectChanges();
      
    } catch (error) {
      console.error('❌ Translation error:', error);
      translation.translated = 'Error: Servicio de traducción no disponible';
      translation.translating = false;
      this.cdr.detectChanges();
      
      this.snackBar.open('⚠️ Error al traducir. Intenta con texto más corto.', 'OK', { duration: 3000 });
    }
  }

  removeTranslation(index: number): void {
    this.translations.splice(index, 1);
  }

  clearAllTranslations(): void {
    this.translations = [];
    this.snackBar.open('🧹 Traducciones limpiadas', 'OK', { duration: 1500 });
  }

  toggleTranslationPanel(): void {
    this.showTranslationPanel = !this.showTranslationPanel;
  }

  async translateSelection(): Promise<void> {
    // This method is no longer needed but keeping for compatibility
  }

  closeTranslation(): void {
    // This method is no longer needed but keeping for compatibility
  }
}
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DestroyRef } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// import { AudioService } from './services/audio-service';
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { MatIconModule } from '@angular/material/icon';
// import { io, Socket } from 'socket.io-client';
// import { environment } from '../environments/environment';

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
// export class App implements AfterViewChecked {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private destroyRef = inject(DestroyRef);
//   private socket: Socket;
//   private sessionId = Date.now().toString();
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);
  
//   public currentPartial: { text: string; lang: string } = { text: '', lang: '' };
//   bloques: { text: string; lang: string }[] = [];

//   // Translation feature - Panel lateral
//   showTranslationPanel = true;
//   translations: Array<{
//     original: string;
//     translated: string;
//     sourceLang: string;
//     targetLang: string;
//     translating: boolean;
//   }> = [];

//   private silenceTimer: any;
//   private lastPartialTime = 0;
//   private silenceTimeout = 1500; // 1.5s sin partials → finalizar bloque
//   private previousTranscriptionLength = 0;
//  autoScrollEnabled = true;

//   constructor() {
//     this.socket = io(environment.apiUrl);
    
//     this.socket.on('connect', () => {
//       console.log('✅ Socket conectado a backend!');
//     });

//     this.socket.on('partialTranscript', (dataStr: string) => {
//       console.log('📥 Frontend recibido partialTranscript:', dataStr.substring(0, 100));
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId === this.sessionId && data.text.trim()) {
//           const newText = data.text.trim();
          
//           // FRONTEND-ONLY LANGUAGE DETECTION (backend multilingual model doesn't return accurate lang)
//           const spanishPattern = /\b(de|del|el|la|los|las|un|una|está|están|son|es|como|qué|cómo|por|para|con|sin|pero|y|o|mi|tu|su|me|te|se|lo|le|ha|he|sido|sé|qué|vamos|hacer|entonces|juro|ninguna|solo|diagnosticado|prediabetes|cuidando|dieta|hago|ejercicio|tomo|medicina|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|años|año|mes|meses|día|días|calle|mientras|recorremos|lugares|más|espectaculares|nada|esto|no|hola|adiós|gracias|por favor|señor|señora|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/gi;
          
//           // Also check for Spanish-specific characters
//           const hasSpanishChars = /[áéíóúñ¿¡]/i.test(newText);
          
//           // Detect language from the NEW text chunk
//           const spanishMatches = newText.match(spanishPattern);
//           const wordCount = newText.split(/\s+/).length;
//           const spanishWordCount = spanishMatches ? spanishMatches.length : 0;
          
//           // Determine language: Spanish if has Spanish chars OR 25%+ words are Spanish OR 2+ Spanish words in short phrase
//           let detectedLang = 'en';
//           if (hasSpanishChars || (spanishMatches && ((spanishWordCount / wordCount >= 0.25) || (spanishWordCount >= 2 && wordCount <= 6)))) {
//             detectedLang = 'es';
//             console.log(`🔍 Detected SPANISH: ${spanishWordCount}/${wordCount} words${hasSpanishChars ? ' + Spanish chars' : ''} in "${newText.substring(0, 40)}..."`);
//           } else {
//             console.log(`🔍 Detected ENGLISH: ${spanishWordCount}/${wordCount} Spanish words in "${newText.substring(0, 40)}..."`);
//           }
          
//           this.lastPartialTime = Date.now();

//           // Check for LANGUAGE CHANGE
//           const currentWordCount = this.currentPartial.text.split(/\s+/).filter(w => w).length;
//           const languageChanged = this.currentPartial.text.trim() && 
//                                   currentWordCount >= 3 && // At least 3 words before switching
//                                   this.currentPartial.lang !== detectedLang;

//           if (data.isNewTurn) {
//             // FINAL from backend: Finalize current partial block
//             if (this.currentPartial.text.trim()) {
//               this.bloques.push({ ...this.currentPartial });
//               console.log(`✅ FINALIZED bloque #${this.bloques.length} [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 50)}..."`);
//             }
//             // Start new partial with new final text
//             this.currentPartial = { text: newText, lang: detectedLang };
//             console.log(`🆕 NEW TURN started with [${detectedLang}]: "${newText.substring(0, 50)}..."`);
//           } else if (languageChanged) {
//             // Language switched! Finalize current block and start new one
//             this.bloques.push({ ...this.currentPartial });
//             console.log(`🌐 LANGUAGE CHANGE! Finalized [${this.currentPartial.lang}] bloque #${this.bloques.length} (${currentWordCount} words), starting [${detectedLang}] bloque`);
//             this.currentPartial = { text: newText, lang: detectedLang };
//           } else {
//             // PARTIAL: APPEND new text to current partial
//             if (this.currentPartial.text) {
//               this.currentPartial.text += ' ' + newText;
//               // Update language for first 3 words to allow early correction
//               if (currentWordCount < 3) {
//                 this.currentPartial.lang = detectedLang;
//                 console.log(`🔄 Early lang update to [${detectedLang}] at ${currentWordCount + wordCount} words`);
//               }
//             } else {
//               this.currentPartial.text = newText;
//               this.currentPartial.lang = detectedLang;
//             }
//             console.log(`📝 APPENDED [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 60)}..." (${this.currentPartial.text.split(/\s+/).filter(w => w).length} words)`);
//           }
          
//           this.updateTranscription();
//         }
//       } catch (e) {
//         console.error('❌ Error parsing partial:', e, dataStr);
//       }
//     });

//     this.socket.on('error', (err) => {
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
//       if (this.currentPartial.text.trim()) {
//         this.bloques.push({ ...this.currentPartial });
//         console.log(`✅ Finalizado parcial en stop: "${this.currentPartial.text.substring(0, 50)}..."`);
//         this.currentPartial = { text: '', lang: '' };
//         this.updateTranscription();
//       }
//     });

//     this.socket.on('chunkReceived', (data: any) => {
//       console.log('📦 Chunk recibido en backend:', data.size, 'bytes');
//     });
//   }

//   private startSilenceTimer(): void {
//     this.silenceTimer = setInterval(() => {
//       if (this.isRecording && this.currentPartial.text.trim() && 
//           (Date.now() - this.lastPartialTime > this.silenceTimeout)) {
//         // Silence detected: Finalize current partial
//         this.bloques.push({ ...this.currentPartial });
//         console.log(`⏱️ SILENCE FINALIZED bloque #${this.bloques.length} [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 50)}..."`);
//         this.currentPartial = { text: '', lang: '' };
//         this.lastPartialTime = Date.now();
//         this.updateTranscription();
//       }
//     }, 250);
//   }

//   private stopSilenceTimer(): void {
//     if (this.silenceTimer) {
//       clearInterval(this.silenceTimer);
//       this.silenceTimer = null;
//     }
//   }

//   private updateTranscription(): void {
//     // Combine bloques + current partial for display
//     const allBlocks = [...this.bloques];
//     if (this.currentPartial.text.trim()) {
//       allBlocks.push(this.currentPartial);
//     }
    
//     this.transcription = allBlocks
//       .filter(b => b.text.trim())
//       .map(b => `[${b.lang.toUpperCase()}] ${b.text}`)
//       .join('\n\n');
    
//     console.log(`🔄 UI updated (bloques finalizados: ${this.bloques.length}, parcial activo: ${this.currentPartial.text.length} chars)`);
//     this.cdr.detectChanges();
    
//     // Auto-scroll if content grew
//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 100);
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();

//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.currentPartial = { text: '', lang: '' };
//       this.lastPartialTime = Date.now();
//       this.previousTranscriptionLength = 0;
//       this.loading = true;

//       this.snackBar.open('🎙️ Transcripción real-time iniciada...', 'OK', { duration: 3000 });

//       this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       console.log('📤 Emitido startTranscription para session', this.sessionId);

//       this.audioService.chunk$
//         .pipe(takeUntilDestroyed(this.destroyRef))
//         .subscribe((blob: Blob) => {
//           console.log('📦 Chunk listo para enviar:', blob.size, 'bytes');
//           blob.arrayBuffer().then(buffer => {
//             const uint8 = new Uint8Array(buffer);
//             this.socket.emit('audioChunk', { 
//               sessionId: this.sessionId, 
//               chunk: Array.from(uint8)
//             });
//           });
//         });

//     } catch (err: any) {
//       console.error('❌ Error completo:', err);
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
    
//     // Clear all transcription data on stop
//     this.clearTranscription();
    
//     this.snackBar.open('🛑 Transcripción detenida y limpiada.', 'OK', { duration: 2000 });
//   }

//   clearTranscription() {
//     const wasEmpty = this.bloques.length === 0 && !this.currentPartial.text.trim();
    
//     this.transcription = '';
//     this.bloques = [];
//     this.currentPartial = { text: '', lang: '' };
//     this.previousTranscriptionLength = 0;
//     this.cdr.detectChanges();
    
//     if (!wasEmpty) {
//       console.log('🧹 Transcription cleared');
//       this.snackBar.open('🧹 Transcripción limpiada', 'OK', { duration: 1500 });
//     }
//   }

//   ngAfterViewChecked(): void {
//     if (this.transcription && this.autoScrollEnabled) {
//       this.scrollToBottom();
//     }
//   }

//   ngOnDestroy() {
//     this.stopSilenceTimer();
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
//     const atBottom = this.isAtBottom();
//     if (!atBottom) {
//       this.autoScrollEnabled = false;
//       console.log('👤 User scrolled up: Auto-scroll disabled');
//     } else {
//       this.autoScrollEnabled = true;
//       console.log('👤 User at bottom: Auto-scroll re-enabled');
//     }
//   }

//   onTextSelection(): void {
//     const selection = window.getSelection();
//     const selectedText = selection?.toString().trim();
    
//     if (selectedText && selectedText.length > 0) {
//       // Limit selection to 500 characters
//       const textToTranslate = selectedText.length > 500 
//         ? selectedText.substring(0, 500) 
//         : selectedText;
      
//       if (selectedText.length > 500) {
//         this.snackBar.open('⚠️ Texto truncado a 500 caracteres', 'OK', { duration: 2000 });
//       }
      
//       console.log(`📝 Text selected (${textToTranslate.length} chars): "${textToTranslate.substring(0, 30)}..."`);
      
//       // Add to translations panel and translate immediately
//       this.addTranslation(textToTranslate);
      
//       // Clear selection
//       selection?.removeAllRanges();
//     }
//   }

//   addTranslation(text: string): void {
//     // Detect source language - IMPROVED with Spanish chars check
//     const spanishPattern = /\b(de|del|el|la|los|las|un|una|está|están|son|es|como|qué|cómo|por|para|con|sin|pero|y|o|mi|tu|su|me|te|se|lo|le|ha|he|sido|sé|qué|vamos|hacer|entonces|juro|ninguna|solo|diagnosticado|prediabetes|cuidando|dieta|hago|ejercicio|tomo|medicina|calle|mientras|recorremos|lugares|más|espectaculares|nada|esto|no)\b/gi;
//     const hasSpanishChars = /[áéíóúñ¿¡]/i.test(text);
//     const spanishMatches = text.match(spanishPattern);
//     const wordCount = text.split(/\s+/).length;
//     const spanishWordCount = spanishMatches ? spanishMatches.length : 0;
    
//     // Spanish if has special chars OR 25%+ Spanish words OR 2+ Spanish words in phrases ≤6 words
//     const isSpanish = hasSpanishChars || 
//                       (spanishMatches && ((spanishWordCount / wordCount >= 0.25) || (spanishWordCount >= 2 && wordCount <= 6)));
    
//     const sourceLang = isSpanish ? 'es' : 'en';
//     const targetLang = isSpanish ? 'en' : 'es';
    
//     console.log(`📊 Translation detection: ${spanishWordCount}/${wordCount} Spanish words${hasSpanishChars ? ' + Spanish chars' : ''} → ${sourceLang} to ${targetLang}`);
    
//     // Add to beginning of array (most recent first)
//     const translation = {
//       original: text,
//       translated: '',
//       sourceLang,
//       targetLang,
//       translating: true
//     };
    
//     this.translations.unshift(translation);
    
//     // Auto-translate
//     this.translateItem(translation);
//   }

//   async translateItem(translation: any): Promise<void> {
//     try {
//       console.log(`🌐 Translating from ${translation.sourceLang} to ${translation.targetLang}: "${translation.original.substring(0, 30)}..."`);
      
//       // Truncate text if too long (max 500 chars for free APIs)
//       const textToTranslate = translation.original.length > 500 
//         ? translation.original.substring(0, 500) + '...' 
//         : translation.original;
      
//       let translated = '';
      
//       // Try LibreTranslate first
//       try {
//         const response = await fetch('https://libretranslate.com/translate', {
//           method: 'POST',
//           headers: {
//             'Content-Type': 'application/json',
//           },
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
//         } else {
//           throw new Error('LibreTranslate failed');
//         }
//       } catch (libreError) {
//         console.warn('LibreTranslate failed, trying MyMemory API...', libreError);
        
//         // Fallback to MyMemory API (no limits, free)
//         const langPair = `${translation.sourceLang}|${translation.targetLang}`;
//         const myMemoryUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=${langPair}`;
        
//         const response = await fetch(myMemoryUrl);
        
//         if (!response.ok) {
//           throw new Error('MyMemory API failed');
//         }
        
//         const data = await response.json();
//         if (data.responseStatus === 200 && data.responseData?.translatedText) {
//           translated = data.responseData.translatedText;
//         } else {
//           throw new Error('MyMemory returned invalid data');
//         }
//       }
      
//       translation.translated = translated;
//       translation.translating = false;
      
//       console.log(`✅ Translation: "${translation.translated.substring(0, 50)}..."`);
//       this.cdr.detectChanges();
      
//     } catch (error) {
//       console.error('❌ Translation error:', error);
//       translation.translated = 'Error: Servicio de traducción no disponible';
//       translation.translating = false;
//       this.cdr.detectChanges();
      
//       this.snackBar.open('⚠️ Error al traducir. Intenta con texto más corto.', 'OK', { duration: 3000 });
//     }
//   }

//   removeTranslation(index: number): void {
//     this.translations.splice(index, 1);
//   }

//   clearAllTranslations(): void {
//     this.translations = [];
//     this.snackBar.open('🧹 Traducciones limpiadas', 'OK', { duration: 1500 });
//   }

//   toggleTranslationPanel(): void {
//     this.showTranslationPanel = !this.showTranslationPanel;
//   }

//   async translateSelection(): Promise<void> {
//     // This method is no longer needed but keeping for compatibility
//   }

//   closeTranslation(): void {
//     // This method is no longer needed but keeping for compatibility
//   }
// }
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DestroyRef } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// import { AudioService } from './services/audio-service';

// // Angular Material Modules
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { io, Socket } from 'socket.io-client';

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [
//     CommonModule,
//     MatCardModule,
//     MatButtonModule,
//     MatSnackBarModule,
//     MatProgressSpinnerModule
//   ],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

// private destroyRef = inject(DestroyRef);
//   private socket: Socket;
//   private sessionId = Date.now().toString();
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);
//   public currentPartial: { text: string; lang: string } = { text: '', lang: '' }; // Temporal partial block
//   bloques: { text: string; lang: string }[] = []; // Definitive blocks

//   private silenceTimer: any; // Timer for silence detection
//   private lastPartialTime = 0; // Timestamp last partial
//   private silenceTimeout = 500; // 500ms no partial → finalize

//   private previousTranscriptionLength = 0; // Track for throttle
//    isUserScrolling = false; // Flag: User manual scroll (disable auto)
//   private autoScrollEnabled = true; // Enable/disable auto-scroll


//   constructor() {
//     this.socket = io('http://localhost:3000');
//     this.socket.on('connect', () => {
//       console.log('Socket conectado a backend!');
//     });
//     this.socket.on('partialTranscript', (dataStr: string) => {
//       console.log('Frontend recibido partialTranscript:', dataStr);
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId === this.sessionId && data.text.trim()) {
//           const newText = data.text.trim();
//           const detectedLang = data.lang || 'en';
//           this.lastPartialTime = Date.now(); // Reset silence timer on new partial
//           console.log(`Parsing partial/final: "${newText.substring(0, 50)}..." (isNewTurn: ${data.isNewTurn})`);
//           if (data.isNewTurn) {
//             // Backend final: Convert partial to definitive, add to list, clear partial
//             if (this.currentPartial.text.trim()) {
//               this.bloques.push({ ...this.currentPartial });
//               console.log(`*** BACKEND FINALIZED bloque [${detectedLang}]: "${this.currentPartial.text.substring(0, 50)}..."`);
//             }
//             this.currentPartial = { text: '', lang: '' };
//           } else {
//             // Partial: Update temporal block
//             this.currentPartial = { text: newText, lang: detectedLang };
//             console.log(`Actualizado bloque temporal [${detectedLang}]: "${newText.substring(0, 50)}..."`);
//           }
//           this.updateTranscription();
//         }
//       } catch (e) {
//         console.error('Error parsing partial:', e, dataStr);
//       }
//     });
//     this.socket.on('error', (err) => {
//       console.error('WS error:', err);
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });
//     this.socket.on('started', (data: any) => {
//       console.log('Real-time iniciado para session', data.sessionId);
//       this.loading = false;
//       this.startSilenceTimer(); // Start silence detection
//     });
//     this.socket.on('stopped', (data: any) => {
//       console.log('Real-time detenido para session', data.sessionId);
//       this.stopSilenceTimer();
//       // Finalize partial on stop
//       if (this.currentPartial.text.trim()) {
//         this.bloques.push({ ...this.currentPartial });
//         console.log(`Finalizado parcial en bloque definitivo on stop: "${this.currentPartial.text.substring(0, 50)}..."`);
//         this.currentPartial = { text: '', lang: '' };
//         this.updateTranscription();
//       }
//     });
//     this.socket.on('chunkReceived', (data: any) => {
//       console.log('Chunk recibido en backend:', data.size, 'bytes');
//     });
//   }

//   private startSilenceTimer(): void {
//     this.silenceTimer = setInterval(() => {
//       if (this.isRecording && this.currentPartial.text.trim() && (Date.now() - this.lastPartialTime > this.silenceTimeout)) {
//         // Silence ≥500ms detected! Finalize current to definitive
//         this.bloques.push({ ...this.currentPartial });
//         console.log(`*** FRONTEND SILENCE DETECTED (≥500ms no partial)! LIVE FINALIZED bloque [${this.currentPartial.lang}]: "${this.currentPartial.text.substring(0, 50)}..." (trazabilidad mantenida)`);
//         this.currentPartial = { text: '', lang: '' };
//         this.lastPartialTime = Date.now(); // Reset to avoid loop
//         this.updateTranscription();
//       } else if (this.isRecording && this.currentPartial.text.trim() && (Date.now() - this.lastPartialTime < this.silenceTimeout)) {
//         console.log(`Silencio corto (<500ms): Continúa temporal "${this.currentPartial.text.substring(0, 20)}..."`);
//       }
//     }, 250); // Check every 250ms (más responsive)
//   }

//   private stopSilenceTimer(): void {
//     if (this.silenceTimer) {
//       clearInterval(this.silenceTimer);
//       this.silenceTimer = null;
//     }
//   }

//   private updateTranscription(): void {
//     this.transcription = [...this.bloques, this.currentPartial].filter(b => b.text.trim()).map(b => `[${b.lang.toUpperCase()}] ${b.text}`).join('\n\n');
//     console.log(`UI updated live (bloques: ${this.bloques.length}, partial len: ${this.currentPartial.text.length})`);
//     this.cdr.detectChanges();
//     // Scroll only if new content (no lag/jump on >2 blocks)
//     if (this.transcription.length > this.previousTranscriptionLength) {
//       setTimeout(() => this.scrollToBottom(), 100); // Delay 100ms for reflow
//       this.previousTranscriptionLength = this.transcription.length;
//     }
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();

//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.currentPartial = { text: '', lang: '' };
//       this.lastPartialTime = Date.now();
//       this.previousTranscriptionLength = 0; // Reset length track
//       this.loading = true;

//       this.snackBar.open('Transcripción real-time iniciada...', 'OK', { duration: 3000 });

//       this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       console.log('Emitido startTranscription para session', this.sessionId);

//       this.audioService.chunk$
//         .pipe(takeUntilDestroyed(this.destroyRef))
//         .subscribe((blob: Blob) => {
//           console.log('Chunk listo para enviar:', blob.size, 'bytes');
//           blob.arrayBuffer().then(buffer => {
//             const uint8 = new Uint8Array(buffer);
//             this.socket.emit('audioChunk', { 
//               sessionId: this.sessionId, 
//               chunk: Array.from(uint8)
//             });
//             console.log('Chunk emitido a backend como array');
//           });
//         });

//     } catch (err: any) {
//       console.error('Error completo:', err);
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
//     this.stopSilenceTimer(); // Stop timer
//     this.snackBar.open('Transcripción detenida.', 'OK');
//   }

//   ngAfterViewChecked(): void {
//     if (this.transcription) {
//       this.scrollToBottom();
//     }
//   }

//   ngOnDestroy() {
//     this.stopSilenceTimer();
//     this.socket.disconnect();
//   }

// private scrollToBottom(): void {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); // Smooth behavior
//     }
//   }
//   private isAtBottom(): boolean {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       return el.scrollTop + el.clientHeight >= el.scrollHeight - 10; // Tolerance 10px
//     }
//     return false;
//   }

//   onContainerScroll(event: Event): void {
//     const el = event.target as HTMLElement;
//     const atBottom = this.isAtBottom();
//     if (!atBottom) {
//       this.autoScrollEnabled = false; // Disable auto if user scrolls up
//       console.log('User scrolled up: Auto-scroll disabled');
//     } else {
//       this.autoScrollEnabled = true; // Re-enable if user back to bottom
//       console.log('User at bottom: Auto-scroll re-enabled');
//     }
//   }
// }
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DestroyRef } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// import { AudioService } from './services/audio-service';

// // Angular Material Modules
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { io, Socket } from 'socket.io-client';

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [
//     CommonModule,
//     MatCardModule,
//     MatButtonModule,
//     MatSnackBarModule,
//     MatProgressSpinnerModule
//   ],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked {
//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private destroyRef = inject(DestroyRef);
//   private socket: Socket;
//   private sessionId = Date.now().toString();
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);
//   private lastPartial = '';
//   bloques: { text: string; lang: string }[] = [];

//   constructor() {
//     this.socket = io('http://localhost:3000');
//     this.socket.on('connect', () => {
//       console.log('Socket conectado a backend!');
//     });
//     this.socket.on('connect_error', (err) => {
//       console.error('Socket error:', err.message);
//     });
//     this.socket.on('disconnect', () => {
//       console.log('Socket desconectado');
//     });
//     this.socket.on('partialTranscript', (dataStr: string) => {
//       try {
//         const data = JSON.parse(dataStr);
//         if (data.sessionId === this.sessionId && data.text.trim()) {
//           const newText = data.text.trim();
//           const detectedLang = data.lang || 'auto';
//           if (data.isNewTurn || this.lastPartial !== newText || (this.bloques.length > 0 && this.bloques[this.bloques.length - 1].lang !== detectedLang)) {
//             this.bloques.push({ text: newText, lang: detectedLang });
//             this.lastPartial = newText;
//             console.log(`Nuevo bloque [${detectedLang}]:`, newText);
//           } else {
//             this.bloques[this.bloques.length - 1].text = newText;
//           }
//           this.transcription = this.bloques.map(b => `[${b.lang.toUpperCase()}] ${b.text}`).join('\n\n');
//           this.cdr.detectChanges();
//           setTimeout(() => this.scrollToBottom(), 50);
//         }
//       } catch (e) {
//         console.error('Error parsing partial:', e, dataStr);
//       }
//     });
//     this.socket.on('error', (err) => {
//       console.error('WS error:', err);
//       this.snackBar.open(err.message || 'Error en backend', 'OK', { duration: 5000 });
//     });
//     this.socket.on('started', (data: any) => {
//       console.log('Real-time iniciado para session', data.sessionId);
//     });
//     this.socket.on('stopped', (data: any) => {
//       console.log('Real-time detenido para session', data.sessionId);
//     });
//     this.socket.on('chunkReceived', (data: any) => {
//       console.log('Chunk recibido en backend:', data.size, 'bytes');
//     });
//   }

//   async startRecording() {
//     try {
//       await this.audioService.startTabAudioCapture();

//       this.isRecording = true;
//       this.transcription = '';
//       this.bloques = [];
//       this.lastPartial = '';
//       this.loading = true;

//       this.snackBar.open('Transcripción real-time de pestaña iniciada...', 'OK', { duration: 3000 });

//       this.socket.emit('startTranscription', { sessionId: this.sessionId });
//       console.log('Emitido startTranscription para session', this.sessionId);

//       this.audioService.chunk$
//         .pipe(takeUntilDestroyed(this.destroyRef))
//         .subscribe((blob: Blob) => {
//           console.log('Chunk listo para enviar:', blob.size, 'bytes');
//           blob.arrayBuffer().then(buffer => {
//             const uint8 = new Uint8Array(buffer);
//             this.socket.emit('audioChunk', { 
//               sessionId: this.sessionId, 
//               chunk: Array.from(uint8)
//             });
//             console.log('Chunk emitido a backend como array');
//           });
//         });

//     } catch (err: any) {
//       console.error('Error completo:', err);
//       this.loading = false;
//       this.isRecording = false;
//       let msg = err.message || 'Error al iniciar captura de pestaña.';
//       if (err.name === 'NotSupportedError') msg = 'Screen capture con audio no soportado. Usa Chrome 72+ + HTTPS (ng serve --ssl true).';
//       if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio de pestaña" en el popup.';
//       if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona una pestaña con audio (e.g., YouTube video).';

//       this.snackBar.open(msg, 'OK', { duration: 5000 });
//     }
//   }

//   stopRecording() {
//     this.socket.emit('stopTranscription', { sessionId: this.sessionId });
//     this.audioService.stopRecording();
//     this.isRecording = false;
//     this.loading = false;
//     this.snackBar.open('Transcripción real-time detenida.', 'OK');
//   }

//   onScroll(event: Event): void {
//     const element = event.target as HTMLElement;
//     console.log('Scroll position:', element.scrollTop);
//   }

//   ngAfterViewChecked(): void {
//     if (this.isRecording && this.transcription) {
//       this.scrollToBottom();
//     }
//   }

//   ngOnDestroy() {
//     this.socket.disconnect();
//   }

//   private scrollToBottom(): void {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTop = el.scrollHeight;
//     }
//   }
// }
// import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DestroyRef } from '@angular/core';
// import { CommonModule } from '@angular/common';

// import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// import { AudioService } from './services/audio-service';

// // Angular Material Modules
// import { MatCardModule } from '@angular/material/card';
// import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
// import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
// import { MatButtonModule } from '@angular/material/button';
// import { io, Socket } from 'socket.io-client';

// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [
//     CommonModule,
//     MatCardModule,
//     MatButtonModule,
//     MatSnackBarModule,
//     MatProgressSpinnerModule
//   ],
//   templateUrl: './app.html',
//   styleUrls: ['./app.css']
// })
// export class App implements AfterViewChecked {

//   title = 'GetIntercall';
//   isRecording = false;
//   transcription = '';
//   loading = false;

//   @ViewChild('scrollMe', { static: false }) scrollMe!: ElementRef<HTMLDivElement>;

//   private destroyRef = inject(DestroyRef);
//   private socket: Socket;
//   private sessionId = Date.now().toString();
//   private audioService = inject(AudioService);
//   private cdr = inject(ChangeDetectorRef);
//   private snackBar = inject(MatSnackBar);

//   constructor() {
//     this.socket = io('http://localhost:3000');
//     // Logs para debug conexión
//     this.socket.on('connect', () => {
//       console.log('Socket conectado a backend!');
//     });
//     this.socket.on('connect_error', (err) => {
//       console.error('Socket error:', err.message);
//     });
//     this.socket.on('disconnect', () => {
//       console.log('Socket desconectado');
//     });
//     this.socket.on('partialTranscript', (data: { text: string }) => {
//       console.log('Partial recibido:', data.text);
//       if (data.text.trim()) {
//         this.transcription += ' ' + data.text;
//         this.cdr.detectChanges();
//         setTimeout(() => this.scrollToBottom(), 50);
//       }
//     });
//     this.socket.on('error', (err) => {
//       console.error('WS error:', err);
//     });
//   }

// async startRecording() {
//   try {
//     await this.audioService.startTabAudioCapture(); // Solo screen, throws if fails

//     this.isRecording = true;
//     this.transcription = '';
//     this.loading = true;

//     this.snackBar.open('Transcripción real-time de pestaña iniciada...', 'OK', { duration: 3000 });

//     this.socket.emit('startTranscription', { sessionId: this.sessionId });
//     console.log('Emitido startTranscription para session', this.sessionId);

// // Envía chunks
// this.audioService.chunk$
//   .pipe(takeUntilDestroyed(this.destroyRef))
//   .subscribe((blob: Blob) => {
//     console.log('Chunk listo para enviar:', blob.size, 'bytes');
//     blob.arrayBuffer().then(buffer => {
//       const uint8 = new Uint8Array(buffer);
//       this.socket.emit('audioChunk', { 
//         sessionId: this.sessionId, 
//         chunk: Array.from(uint8) // ← Fix: Array serializable
//       });
//       console.log('Chunk emitido a backend como array');
//     });
//   });

//   } catch (err: any) {
//     console.error('Error completo:', err);
//     this.loading = false;
//     this.isRecording = false;
//     let msg = err.message || 'Error al iniciar captura de pestaña.';
//     if (err.name === 'NotSupportedError') msg = 'Screen capture con audio no soportado. Usa Chrome 72+ + HTTPS (ng serve --ssl true).';
//     if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Marca "Compartir audio de pestaña" en el popup.';
//     if (err.name === 'AbortError') msg = 'Captura cancelada. Selecciona una pestaña con audio (e.g., YouTube video).';

//     this.snackBar.open(msg, 'OK', { duration: 5000 });
//   }
// }

//   stopRecording() {
//     this.socket.emit('stopTranscription', { sessionId: this.sessionId });
//     this.socket.disconnect();
//     this.audioService.stopRecording();
//     this.isRecording = false;
//     this.loading = false;
//     this.snackBar.open('Transcripción real-time detenida.', 'OK');
//   }

//   onScroll(event: Event): void {
//     const element = event.target as HTMLElement;
//     console.log('Scroll position:', element.scrollTop);
//   }

//   ngAfterViewChecked(): void {
//     if (this.isRecording && this.transcription) {
//       this.scrollToBottom();
//     }
//   }

//   ngOnDestroy() {
//     this.socket.disconnect();
//   }

//   private scrollToBottom(): void {
//     if (this.scrollMe) {
//       const el = this.scrollMe.nativeElement;
//       el.scrollTop = el.scrollHeight;
//     }
//   }
// }