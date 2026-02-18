import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private isRecording = false;

  // Se recrea en cada startTabAudioCapture() — NUNCA se llama .complete()
  private chunkSubject = new Subject<ArrayBuffer>();
  chunk$ = this.chunkSubject.asObservable();

  private pcmBuffer = new Int16Array(800); // 50ms a 16kHz
  private bufferIndex = 0;
  private chunksReceived = 0;
  private lastVoiceTime = 0;
  private readonly SILENCE_LOG_THRESHOLD = 3000;

  async startTabAudioCapture() {
    // Nuevo Subject en cada grabación — el anterior puede estar "muerto"
    this.chunkSubject = new Subject<ArrayBuffer>();
    this.chunk$ = this.chunkSubject.asObservable();

    console.log('Abriendo selector de pestaña...');
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // @ts-ignore
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          sampleRate: 16000,
        } as any,
      });
      console.log('✅ Stream capturado');
      stream.getVideoTracks().forEach(track => track.enabled = false);
    } catch (err: any) {
      throw new Error(`Screen capture falló: ${err.name}. Usa Chrome + HTTPS.`);
    }

    if (stream.getAudioTracks().length === 0) {
      throw new Error('Stream sin audio tracks — marca "Compartir audio" en el diálogo');
    }

    const audioTrack = stream.getAudioTracks()[0];
    const settings = audioTrack.getSettings();
    console.log(`🎤 Audio track: sampleRate=${settings.sampleRate}, channels=${settings.channelCount}`);

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(stream);

    // Gain x3 — conservador para no clipear el audio (x50 anterior saturaba el VAD)
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 3;

    // Compresor conservador — normaliza dinámica sin distorsionar
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;

    console.log('🔊 Audio: Gain x3 + Compresor ratio:4');

    await this.audioContext.audioWorklet.addModule(
      URL.createObjectURL(new Blob([`
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.port.onmessage = (e) => {
              if (e.data === 'stop') this.port.postMessage('stopped');
            };
          }
          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input && input[0]) {
              const inputData = input[0];
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                const sample = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
              }
              this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `], { type: 'application/javascript' }))
    );

    this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');

    this.source.connect(this.gainNode);
    this.gainNode.connect(this.compressor);
    this.compressor.connect(this.processor);

    this.bufferIndex = 0;
    this.chunksReceived = 0;
    this.lastVoiceTime = Date.now();

    this.processor.port.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;

      const pcmData = new Int16Array(e.data);

      for (let i = 0; i < pcmData.length; i++) {
        this.pcmBuffer[this.bufferIndex++] = pcmData[i];

        if (this.bufferIndex >= this.pcmBuffer.length) {
          const chunk = new Int16Array(this.pcmBuffer.length);
          chunk.set(this.pcmBuffer);
          this.bufferIndex = 0;
          this.chunksReceived++;

          // SIEMPRE enviar audio — nunca cortar por silencio en el frontend.
          // AssemblyAI tiene su propio VAD. Cortar aquí causa pérdida del inicio de frases.
          const audioBuffer = new ArrayBuffer(chunk.byteLength);
          new Int16Array(audioBuffer).set(chunk);
          this.chunkSubject.next(audioBuffer);

          // Logging cada 20 chunks (~1 segundo)
          if (this.chunksReceived % 20 === 0) {
            const level = this.calculateAudioLevel(chunk);
            const now = Date.now();
            if (level > -50) this.lastVoiceTime = now;
            const silenceDuration = now - this.lastVoiceTime;
            console.log(
              `🎤 Chunk #${this.chunksReceived}: ${level.toFixed(1)}dB` +
              (silenceDuration > this.SILENCE_LOG_THRESHOLD
                ? ` | ⚠️ Silencio: ${(silenceDuration / 1000).toFixed(1)}s`
                : '')
            );
          }
        }
      }
    };

    this.isRecording = true;
    console.log('✅ Grabación iniciada — audio continuo hacia AssemblyAI');
  }

  private calculateAudioLevel(buffer: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += Math.abs(buffer[i]);
    const avg = sum / buffer.length;
    const normalized = avg / 32768;
    return 20 * Math.log10(normalized + 0.0001);
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    if (this.processor) {
      this.processor.port.postMessage('stop');
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.mediaStream.getTracks().forEach(track => track.stop());
      this.source.disconnect();
      this.source = null;
    }
    if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
    if (this.compressor) { this.compressor.disconnect(); this.compressor = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }

    // NO llamar .complete() — causa que chunk$ nunca emita en la siguiente grabación
    // El Subject muere silenciosamente cuando se pierde la referencia.

    this.bufferIndex = 0;
    this.chunksReceived = 0;
    console.log('🛑 Captura detenida');
  }
}

// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {
//   private audioContext: AudioContext | null = null;
//   private source: MediaStreamAudioSourceNode | null = null;
//   private gainNode: GainNode | null = null;
//   private compressor: DynamicsCompressorNode | null = null;
//   private processor: AudioWorkletNode | null = null;
//   private isRecording = false;

//   // FIX: Se recrea en cada startTabAudioCapture(), NUNCA se llama .complete()
//   private chunkSubject = new Subject<ArrayBuffer>();
//   chunk$ = this.chunkSubject.asObservable();

//   private pcmBuffer = new Int16Array(800); // 50ms a 16kHz
//   private bufferIndex = 0;
//   private chunksReceived = 0;
//   private lastVoiceTime = 0;
//   private readonly SILENCE_LOG_THRESHOLD = 3000;

//   async startTabAudioCapture() {
//     // Nuevo Subject en cada grabación — el anterior puede estar "muerto"
//     this.chunkSubject = new Subject<ArrayBuffer>();
//     this.chunk$ = this.chunkSubject.asObservable();

//     console.log('Abriendo selector de pestaña...');
//     let stream: MediaStream;

//     try {
//       stream = await navigator.mediaDevices.getDisplayMedia({
//         video: true,
//         audio: {
//           echoCancellation: false,
//           noiseSuppression: false,
//           autoGainControl: false,
//           // @ts-ignore
//           googEchoCancellation: false,
//           googAutoGainControl: false,
//           googNoiseSuppression: false,
//           googHighpassFilter: false,
//           sampleRate: 16000,
//         } as any,
//       });
//       console.log('✅ Stream capturado');
//       stream.getVideoTracks().forEach(track => track.enabled = false);
//     } catch (err: any) {
//       throw new Error(`Screen capture falló: ${err.name}. Usa Chrome + HTTPS.`);
//     }

//     if (stream.getAudioTracks().length === 0) {
//       throw new Error('Stream sin audio tracks — marca "Compartir audio" en el diálogo');
//     }

//     const audioTrack = stream.getAudioTracks()[0];
//     const settings = audioTrack.getSettings();
//     console.log(`🎤 Audio track: sampleRate=${settings.sampleRate}, channels=${settings.channelCount}`);

//     this.audioContext = new AudioContext({ sampleRate: 16000 });
//     this.source = this.audioContext.createMediaStreamSource(stream);

//     // Gain conservador x3 — x50 clippeaba el audio y rompía el VAD de AssemblyAI
//     this.gainNode = this.audioContext.createGain();
//     this.gainNode.gain.value = 3;

//     // Compresor conservador — normaliza sin distorsionar
//     this.compressor = this.audioContext.createDynamicsCompressor();
//     this.compressor.threshold.value = -24;
//     this.compressor.knee.value = 10;
//     this.compressor.ratio.value = 4;
//     this.compressor.attack.value = 0.003;
//     this.compressor.release.value = 0.1;

//     console.log('🔊 Audio: Gain x3 + Compresor ratio:4');

//     await this.audioContext.audioWorklet.addModule(
//       URL.createObjectURL(new Blob([`
//         class PCMProcessor extends AudioWorkletProcessor {
//           constructor() {
//             super();
//             this.port.onmessage = (e) => {
//               if (e.data === 'stop') this.port.postMessage('stopped');
//             };
//           }
//           process(inputs, outputs, parameters) {
//             const input = inputs[0];
//             if (input && input[0]) {
//               const inputData = input[0];
//               const pcm16 = new Int16Array(inputData.length);
//               for (let i = 0; i < inputData.length; i++) {
//                 const sample = Math.max(-1, Math.min(1, inputData[i]));
//                 pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
//               }
//               this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
//             }
//             return true;
//           }
//         }
//         registerProcessor('pcm-processor', PCMProcessor);
//       `], { type: 'application/javascript' }))
//     );

//     this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');

//     this.source.connect(this.gainNode);
//     this.gainNode.connect(this.compressor);
//     this.compressor.connect(this.processor);

//     this.bufferIndex = 0;
//     this.chunksReceived = 0;
//     this.lastVoiceTime = Date.now();

//     this.processor.port.onmessage = (e) => {
//       if (!(e.data instanceof ArrayBuffer)) return;

//       const pcmData = new Int16Array(e.data);

//       for (let i = 0; i < pcmData.length; i++) {
//         this.pcmBuffer[this.bufferIndex++] = pcmData[i];

//         if (this.bufferIndex >= this.pcmBuffer.length) {
//           const chunk = new Int16Array(this.pcmBuffer.length);
//           chunk.set(this.pcmBuffer);
//           this.bufferIndex = 0;
//           this.chunksReceived++;

//           // SIEMPRE enviar audio — nunca cortar por silencio en el frontend.
//           // AssemblyAI tiene su propio VAD. Cortar aquí causa pérdida del inicio de frases.
//           const audioBuffer = new ArrayBuffer(chunk.byteLength);
//           new Int16Array(audioBuffer).set(chunk);
//           this.chunkSubject.next(audioBuffer);

//           // Logging cada 20 chunks (~1 segundo)
//           if (this.chunksReceived % 20 === 0) {
//             const level = this.calculateAudioLevel(chunk);
//             const now = Date.now();
//             if (level > -50) this.lastVoiceTime = now;
//             const silenceDuration = now - this.lastVoiceTime;
//             console.log(
//               `🎤 Chunk #${this.chunksReceived}: ${level.toFixed(1)}dB` +
//               (silenceDuration > this.SILENCE_LOG_THRESHOLD
//                 ? ` | ⚠️ Silencio: ${(silenceDuration / 1000).toFixed(1)}s`
//                 : '')
//             );
//           }
//         }
//       }
//     };

//     this.isRecording = true;
//     console.log('✅ Grabación iniciada — audio continuo hacia AssemblyAI');
//   }

//   private calculateAudioLevel(buffer: Int16Array): number {
//     let sum = 0;
//     for (let i = 0; i < buffer.length; i++) sum += Math.abs(buffer[i]);
//     const avg = sum / buffer.length;
//     const normalized = avg / 32768;
//     return 20 * Math.log10(normalized + 0.0001);
//   }

//   stopRecording() {
//     if (!this.isRecording) return;
//     this.isRecording = false;

//     if (this.processor) {
//       this.processor.port.postMessage('stop');
//       this.processor.disconnect();
//       this.processor = null;
//     }
//     if (this.source) {
//       this.source.mediaStream.getTracks().forEach(track => track.stop());
//       this.source.disconnect();
//       this.source = null;
//     }
//     if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
//     if (this.compressor) { this.compressor.disconnect(); this.compressor = null; }
//     if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }

//     // NO llamar .complete() — el Subject muere silenciosamente.
//     // El próximo startTabAudioCapture() crea uno nuevo fresco.

//     this.bufferIndex = 0;
//     this.chunksReceived = 0;
//     console.log('🛑 Captura detenida');
//   }
// }

// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {
//   private audioContext: AudioContext | null = null;
//   private source: MediaStreamAudioSourceNode | null = null;
//   private gainNode: GainNode | null = null;
//   private compressor: DynamicsCompressorNode | null = null;
//   private processor: AudioWorkletNode | null = null;
//   private isRecording = false;
//   private chunkSubject = new Subject<Blob>();

//   chunk$ = this.chunkSubject.asObservable();

//   // Buffer for 50ms chunks (800 samples at 16kHz)
//   private pcmBuffer = new Int16Array(800);
//   private bufferIndex = 0;

//   // 🔥 Pre-buffer configuration
//   private preBuffer: Int16Array[] = [];
//   private maxPreBufferChunks = 20; // 20 chunks x 50ms = 1000ms
//   private minPreBufferChunks = 0; // ← DESACTIVAR warm-up, enviar TODO desde inicio
//   private isSendingAudio = true; // ← INICIAR en modo "enviando" para no perder nada
//   private lastVoiceTime = 0;
//   private silenceThreshold = 2000; // ← AUMENTADO a 2.0s para no cortar entre palabras
//   private chunksReceived = 0;

//   async startTabAudioCapture() {
//     console.log('Abriendo selector de pestaña...');
//     let stream: MediaStream;
//     try {
//       stream = await navigator.mediaDevices.getDisplayMedia({
//         video: true,
//         audio: {
//           echoCancellation: false,
//           noiseSuppression: false,
//           autoGainControl: false,
//           // @ts-ignore
//           googEchoCancellation: false,
//           googAutoGainControl: false,
//           googNoiseSuppression: false,
//           googHighpassFilter: false,
//         } as any,
//       });
//       console.log('Stream capturado: Screen share con audio');
//       stream.getVideoTracks().forEach(track => track.enabled = false);
//     } catch (err: any) {
//       console.error('Screen share con audio falló:', err.name, err.message);
//       throw new Error(`Screen capture con audio no soportado: ${err.name}. Usa Chrome + HTTPS.`);
//     }

//     if (stream.getAudioTracks().length === 0) {
//       throw new Error('Stream sin audio tracks');
//     }

//     this.audioContext = new AudioContext({ sampleRate: 16000 });
//     this.source = this.audioContext.createMediaStreamSource(stream);
    
//     this.gainNode = this.audioContext.createGain();
//     this.gainNode.gain.value = 50;
    
//     this.compressor = this.audioContext.createDynamicsCompressor();
//     this.compressor.threshold.value = -50;
//     this.compressor.knee.value = 40;
//     this.compressor.ratio.value = 12;
//     this.compressor.attack.value = 0.003;
//     this.compressor.release.value = 0.25;

//     console.log('🔊 Audio boost: Gain x50 + Compresor + Pre-buffer continuo 1000ms (1s)');

//     await this.audioContext.audioWorklet.addModule(URL.createObjectURL(new Blob([`
//       class PCMProcessor extends AudioWorkletProcessor {
//         constructor() {
//           super();
//           this.port.onmessage = (e) => {
//             if (e.data === 'stop') {
//               this.port.postMessage('stopped');
//             }
//           };
//         }
//         process(inputs, outputs, parameters) {
//           const input = inputs[0];
//           if (input.length > 0) {
//             const inputData = input[0];
//             const pcm16 = new Int16Array(inputData.length);
//             for (let i = 0; i < inputData.length; i++) {
//               let sample = inputData[i] * 32768;
//               pcm16[i] = Math.max(-32768, Math.min(32767, sample));
//             }
//             this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
//             return true;
//           }
//           return true;
//         }
//       }
//       registerProcessor('pcm-processor', PCMProcessor);
//     `], { type: 'application/javascript' })));

//     this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    
//     this.source.connect(this.gainNode);
//     this.gainNode.connect(this.compressor);
//     this.compressor.connect(this.processor);

//     // 🔥 Reset estado al iniciar - EMPEZAR ENVIANDO TODO
//     this.preBuffer = [];
//     this.isSendingAudio = true; // ← Enviar desde el inicio
//     this.lastVoiceTime = Date.now(); // ← Timestamp de inicio
//     this.chunksReceived = 0;

//     this.processor.port.onmessage = (e) => {
//       if (e.data instanceof ArrayBuffer) {
//         const pcmData = new Int16Array(e.data);
        
//         for (let i = 0; i < pcmData.length; i++) {
//           this.pcmBuffer[this.bufferIndex++] = pcmData[i];
          
//           if (this.bufferIndex >= this.pcmBuffer.length) {
//             const chunk = new Int16Array(this.pcmBuffer.length);
//             chunk.set(this.pcmBuffer);
            
//             // 🔥 INCREMENTAR contador
//             this.chunksReceived++;
            
//             // Calcular nivel de audio
//             const avgLevel = this.calculateAudioLevel(chunk);
            
//             // 🔥 SIMPLIFICADO: Enviar TODO el audio siempre, sin detección compleja
//             const hasVoice = avgLevel > -50; // Umbral MÁS bajo para captar todo
//             const now = Date.now();
            
//             // 🔥 ESTRATEGIA NUEVA: Enviar TODO el audio, solo pausar después de silencio largo
//             if (hasVoice) {
//               this.lastVoiceTime = now;
//             }
            
//             const timeSinceLastVoice = now - this.lastVoiceTime;
            
//             // 🔥 Enviar audio SIEMPRE (incluso silencio) durante los primeros 2 segundos después de voz
//             if (timeSinceLastVoice < this.silenceThreshold) {
//               const currentBuffer = new ArrayBuffer(chunk.length * 2);
//               new Int16Array(currentBuffer).set(chunk);
//               this.chunkSubject.next(new Blob([currentBuffer], { type: 'audio/pcm' }));
              
//               if (this.chunksReceived % 20 === 0) {
//                 console.log(`🎤 Enviando: nivel ${avgLevel.toFixed(1)}dB, silencio: ${timeSinceLastVoice}ms`);
//               }
//             } else {
//               // Silencio muy largo, dejar de enviar
//               if (this.chunksReceived % 20 === 0) {
//                 console.log(`🔇 Pausa larga: ${timeSinceLastVoice}ms sin voz`);
//               }
//             }
            
//             this.bufferIndex = 0;
//           }
//         }
//       }
//     };

//     this.isRecording = true;
//     console.log('✅ Grabación iniciada: Modo pre-buffer continuo activo');
//   }

//   private calculateAudioLevel(buffer: Int16Array): number {
//     let sum = 0;
//     for (let i = 0; i < buffer.length; i++) {
//       sum += Math.abs(buffer[i]);
//     }
//     const avg = sum / buffer.length;
//     const normalized = avg / 32768;
//     const db = 20 * Math.log10(normalized + 0.0001);
//     return db;
//   }

//   stopRecording() {
//     if (this.processor) {
//       this.processor.port.postMessage('stop');
//     }
//     if (this.source) {
//       this.source.mediaStream.getTracks().forEach(track => track.stop());
//     }
//     if (this.audioContext) {
//       this.audioContext.close();
//     }
//     this.isRecording = false;
//     this.preBuffer = [];
//     this.isSendingAudio = true;
//     this.chunksReceived = 0;
//     console.log('Captura detenida');
//     this.chunkSubject.complete();
//   }
// }
// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {
//   private audioContext: AudioContext | null = null;
//   private source: MediaStreamAudioSourceNode | null = null;
//   private gainNode: GainNode | null = null; // ← New: Gain for vol boost
//   private processor: AudioWorkletNode | null = null;
//   private isRecording = false;
//   private chunkSubject = new Subject<Blob>();

//   chunk$ = this.chunkSubject.asObservable();

//   // Buffer for 50ms chunks (800 samples at 16kHz)
//   private pcmBuffer = new Int16Array(800);
//   private bufferIndex = 0;

//   async startTabAudioCapture() {
//     console.log('Abriendo selector de pestaña...');
//     let stream: MediaStream;
//     try {
//       stream = await navigator.mediaDevices.getDisplayMedia({
//         video: true, // Requerido para popup
//         audio: true,
//       });
//       console.log('Stream capturado: Screen share con audio');
//       stream.getVideoTracks().forEach(track => track.enabled = false); // Ignore video
//     } catch (err: any) {
//       console.error('Screen share con audio falló:', err.name, err.message);
//       throw new Error(`Screen capture con audio no soportado: ${err.name}. Usa Chrome + HTTPS.`);
//     }

//     if (stream.getAudioTracks().length === 0) {
//       throw new Error('Stream sin audio tracks');
//     }
//     console.log('Stream capturado: Tiene audio', stream.getAudioTracks().length > 0);

//     this.audioContext = new AudioContext({ sampleRate: 16000 });
//     this.source = this.audioContext.createMediaStreamSource(stream);
//     this.gainNode = this.audioContext.createGain(); // ← Gain node
//     this.gainNode.gain.value = 3; // ← Boost vol x3 for low audio tabs

//     // Worklet for PCM16
//     await this.audioContext.audioWorklet.addModule(URL.createObjectURL(new Blob([`
//       class PCMProcessor extends AudioWorkletProcessor {
//         constructor() {
//           super();
//           this.port.onmessage = (e) => {
//             if (e.data === 'stop') {
//               this.port.postMessage('stopped');
//             }
//           };
//         }
//         process(inputs, outputs, parameters) {
//           const input = inputs[0];
//           if (input.length > 0) {
//             const inputData = input[0];
//             // Convert to Int16Array for PCM16
//             const pcm16 = new Int16Array(inputData.length);
//             for (let i = 0; i < inputData.length; i++) {
//               pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
//             }
//             this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
//             return true;
//           }
//           return true;
//         }
//       }
//       registerProcessor('pcm-processor', PCMProcessor);
//     `], { type: 'application/javascript' })));

//     this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
//     // Connect chain: source → gain → processor
//     this.source.connect(this.gainNode);
//     this.gainNode.connect(this.processor);

//     this.processor.port.onmessage = (e) => {
//       if (e.data instanceof ArrayBuffer) {
//         const pcmData = new Int16Array(e.data);
//         // Buffer to 50ms chunks
//         for (let i = 0; i < pcmData.length; i++) {
//           this.pcmBuffer[this.bufferIndex++] = pcmData[i];
//           if (this.bufferIndex >= this.pcmBuffer.length) {
//             // Send 50ms chunk
//             const chunk = new ArrayBuffer(this.pcmBuffer.length * 2);
//             new Int16Array(chunk).set(this.pcmBuffer);
//             console.log('Chunk recibido para real-time: PCM16 50ms', chunk.byteLength, 'bytes');
//             this.chunkSubject.next(new Blob([chunk], { type: 'audio/pcm' }));
//             this.bufferIndex = 0;
//           }
//         }
//       }
//     };

//     this.isRecording = true;
//     console.log('Grabación real-time iniciada con PCM16 50ms chunks (tab audio + gain x3)');
//   }

//   stopRecording() {
//     if (this.processor) {
//       this.processor.port.postMessage('stop');
//     }
//     if (this.source) {
//       this.source.mediaStream.getTracks().forEach(track => track.stop());
//     }
//     if (this.audioContext) {
//       this.audioContext.close();
//     }
//     this.isRecording = false;
//     console.log('Captura detenida');
//     this.chunkSubject.complete();
//   }
// }

// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {
//   private audioContext: AudioContext | null = null;
//   private source: MediaStreamAudioSourceNode | null = null;
//   private processor: AudioWorkletNode | null = null;
//   private isRecording = false;
//   private chunkSubject = new Subject<Blob>();

//   chunk$ = this.chunkSubject.asObservable();

//   // Buffer for 50ms chunks (800 samples at 16kHz)
//   private pcmBuffer = new Int16Array(800);
//   private bufferIndex = 0;

//   async startTabAudioCapture() {
//     console.log('Abriendo selector de pestaña...');
//     let stream: MediaStream;
//     try {
//       // ← Fix: video: true para popup (ignore video track)
//       stream = await navigator.mediaDevices.getDisplayMedia({
//         video: true, // Requerido para popup, aunque no usemos video
//         audio: true,
//       });
//       console.log('Stream capturado: Screen share con audio');
//       // Ignore video track (solo audio)
//       stream.getVideoTracks().forEach(track => track.enabled = false);
//     } catch (err: any) {
//       console.error('Screen share con audio falló:', err.name, err.message);
//       throw new Error(`Screen capture con audio no soportado: ${err.name}. Usa Chrome + HTTPS.`);
//     }

//     if (stream.getAudioTracks().length === 0) {
//       throw new Error('Stream sin audio tracks');
//     }
//     console.log('Stream capturado: Tiene audio', stream.getAudioTracks().length > 0);

//     this.audioContext = new AudioContext({ sampleRate: 16000 });
//     this.source = this.audioContext.createMediaStreamSource(stream);

//     // Worklet for PCM16
//     await this.audioContext.audioWorklet.addModule(URL.createObjectURL(new Blob([`
//       class PCMProcessor extends AudioWorkletProcessor {
//         constructor() {
//           super();
//           this.port.onmessage = (e) => {
//             if (e.data === 'stop') {
//               this.port.postMessage('stopped');
//             }
//           };
//         }
//         process(inputs, outputs, parameters) {
//           const input = inputs[0];
//           if (input.length > 0) {
//             const inputData = input[0];
//             // Convert to Int16Array for PCM16
//             const pcm16 = new Int16Array(inputData.length);
//             for (let i = 0; i < inputData.length; i++) {
//               pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
//             }
//             this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
//             return true;
//           }
//           return true;
//         }
//       }
//       registerProcessor('pcm-processor', PCMProcessor);
//     `], { type: 'application/javascript' })));

//     this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
//     this.source.connect(this.processor);

//     this.processor.port.onmessage = (e) => {
//       if (e.data instanceof ArrayBuffer) {
//         const pcmData = new Int16Array(e.data);
//         // Buffer to 50ms chunks
//         for (let i = 0; i < pcmData.length; i++) {
//           this.pcmBuffer[this.bufferIndex++] = pcmData[i];
//           if (this.bufferIndex >= this.pcmBuffer.length) {
//             // Send 50ms chunk
//             const chunk = new ArrayBuffer(this.pcmBuffer.length * 2);
//             new Int16Array(chunk).set(this.pcmBuffer);
//             console.log('Chunk recibido para real-time: PCM16 50ms', chunk.byteLength, 'bytes');
//             this.chunkSubject.next(new Blob([chunk], { type: 'audio/pcm' }));
//             this.bufferIndex = 0;
//           }
//         }
//       }
//     };

//     this.isRecording = true;
//     console.log('Grabación real-time iniciada con PCM16 50ms chunks (tab audio)');
//   }

//   stopRecording() {
//     if (this.processor) {
//       this.processor.port.postMessage('stop');
//     }
//     if (this.source) {
//       this.source.mediaStream.getTracks().forEach(track => track.stop());
//     }
//     if (this.audioContext) {
//       this.audioContext.close();
//     }
//     this.isRecording = false;
//     console.log('Captura detenida');
//     this.chunkSubject.complete();
//   }
// }
// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {

//   private mediaRecorder: MediaRecorder | null = null;
//   private chunkSubject = new Subject<Blob>();
//   public chunk$ = this.chunkSubject.asObservable();

//   private isRecording = false;

//   async startTabAudioCapture(): Promise<void> {
//     try {
//       console.log('Abriendo selector de pestaña...');

//       const stream = await navigator.mediaDevices.getDisplayMedia({
//         video: { width: 1, height: 1 },
//         audio: true
//       });

//       console.log('Stream capturado:', stream.getAudioTracks().length > 0 ? 'Tiene audio' : 'Sin audio tracks!');

//       const videoTrack = stream.getVideoTracks()[0];
//       if (videoTrack) videoTrack.stop();

//       const mimeTypes = [
//         "audio/webm; codecs=opus",
//         "audio/ogg; codecs=opus",
//         "audio/webm"
//       ];
//       let mimeType = null;
//       for (const mt of mimeTypes) {
//         if (MediaRecorder.isTypeSupported(mt)) {
//           mimeType = mt;
//           break;
//         }
//       }
//       if (!mimeType) {
//         throw new Error('No se soporta ningún formato de audio para MediaRecorder.');
//       }
//       console.log('Usando MIME Type:', mimeType);

//       this.mediaRecorder = new MediaRecorder(stream, { mimeType });

//       this.mediaRecorder.ondataavailable = (event) => {
//         if (event.data.size > 0 && this.isRecording) {
//           console.log('Chunk recibido para real-time:', mimeType, event.data.size, 'bytes');
//           this.chunkSubject.next(event.data); // Emite para WebSocket
//         }
//       };

//       this.mediaRecorder.onerror = (event) => {
//         console.error('Error en MediaRecorder:', event);
//         this.stopRecording();
//       };

//       this.mediaRecorder.onstop = () => {
//         stream.getTracks().forEach(t => t.stop());
//         this.isRecording = false;
//         console.log('Captura detenida');
//       };

//       this.isRecording = true;
//       this.mediaRecorder.start(500); // Chunks de 0.5s para low-latency real-time

//       console.log('Grabación real-time iniciada con', mimeType);

//     } catch (error: any) {
//       console.error('Error en startTabAudioCapture:', error);
//       if (error?.name === 'NotAllowedError') {
//         throw new Error('Permiso denegado. Marca "Compartir audio" en el selector de pestaña.');
//       }
//       if (error?.name === 'NotSupportedError') {
//         throw new Error('Tu navegador no soporta getDisplayMedia con audio. Usa Chrome.');
//       }
//       if (error?.name === 'AbortError') {
//         throw new Error('Captura cancelada. Intenta de nuevo.');
//       }
//       throw new Error('Error al iniciar captura: ' + (error.message || error.name || 'Desconocido'));
//     }
//   }

//   stopRecording(): void {
//     if (this.mediaRecorder && this.isRecording) {
//       this.mediaRecorder.stop();
//       this.isRecording = false;
//     }
//   }
// }


// import { Injectable } from '@angular/core';
// import { Subject } from 'rxjs';

// @Injectable({
//   providedIn: 'root'
// })
// export class AudioService {

//   private mediaRecorder: MediaRecorder | null = null;
//   private chunkSubject = new Subject<Blob>();
//   public chunk$ = this.chunkSubject.asObservable();

//   private isRecording = false;

//   async startTabAudioCapture(): Promise<void> {
//     try {
//       console.log('Abriendo selector de pestaña...');

//       const stream = await navigator.mediaDevices.getDisplayMedia({
//         video: { width: 1, height: 1 },   // Mínimo para permitir audio
//         audio: true
//       });

//       console.log('Stream capturado:', stream.getAudioTracks().length > 0 ? 'Tiene audio' : 'Sin audio tracks!');

//       // Apagamos el video track inmediatamente
//       const videoTrack = stream.getVideoTracks()[0];
//       if (videoTrack) videoTrack.stop();

//       // MIME Type flexible: prueba OGG primero, fallback a webm (más compatible con screen audio)
//       const mimeTypes = [
//         "audio/ogg; codecs=opus",
//         "audio/webm; codecs=opus",
//         "audio/webm"
//       ];
//       let mimeType = null;
//       for (const mt of mimeTypes) {
//         if (MediaRecorder.isTypeSupported(mt)) {
//           mimeType = mt;
//           break;
//         }
//       }
//       if (!mimeType) {
//         throw new Error('No se soporta ningún formato de audio para MediaRecorder.');
//       }
//       console.log('Usando MIME Type:', mimeType);

//       this.mediaRecorder = new MediaRecorder(stream, { mimeType });

//       this.mediaRecorder.ondataavailable = (event) => {
//         if (event.data.size > 0 && this.isRecording) {
//           console.log('Chunk recibido:', mimeType, event.data.size, 'bytes');
//           this.chunkSubject.next(event.data);
//         }
//       };

//       this.mediaRecorder.onerror = (event) => {
//         console.error('Error en MediaRecorder:', event);
//         this.stopRecording(); // Limpia si falla
//       };

//       this.mediaRecorder.onstop = () => {
//         stream.getTracks().forEach(t => t.stop());
//         this.isRecording = false;
//         console.log('Captura detenida');
//       };

//       this.isRecording = true;
//       this.mediaRecorder.start(2000); // Chunks de 2s
//       console.log('Grabación iniciada con', mimeType);

//     } catch (error: any) {
//       console.error('Error en startTabAudioCapture:', error); // ← Log extra
//       if (error?.name === 'NotAllowedError') {
//         throw new Error('Permiso denegado. Marca "Compartir audio" en el selector de pestaña.');
//       }
//       if (error?.name === 'NotSupportedError') {
//         throw new Error('Tu navegador no soporta getDisplayMedia con audio. Usa Chrome.');
//       }
//       if (error?.name === 'AbortError') {
//         throw new Error('Captura cancelada. Intenta de nuevo.');
//       }
//       throw new Error('Error al iniciar captura: ' + (error.message || error.name || 'Desconocido'));
//     }
//   }

//   stopRecording(): void {
//     if (this.mediaRecorder && this.isRecording) {
//       this.mediaRecorder.stop();
//       this.isRecording = false;
//     }
//   }
// }