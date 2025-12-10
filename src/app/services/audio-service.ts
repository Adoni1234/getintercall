import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private isRecording = false;
  private chunkSubject = new Subject<Blob>();

  chunk$ = this.chunkSubject.asObservable();

  // Buffer for 50ms chunks (800 samples at 16kHz)
  private pcmBuffer = new Int16Array(800);
  private bufferIndex = 0;

  async startTabAudioCapture() {
    console.log('Abriendo selector de pestaña...');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      console.log('Stream capturado: Screen share con audio');
      stream.getVideoTracks().forEach(track => track.enabled = false);
    } catch (err: any) {
      console.error('Screen share con audio falló:', err.name, err.message);
      throw new Error(`Screen capture con audio no soportado: ${err.name}. Usa Chrome + HTTPS.`);
    }

    if (stream.getAudioTracks().length === 0) {
      throw new Error('Stream sin audio tracks');
    }
    console.log('Stream capturado: Tiene audio', stream.getAudioTracks().length > 0);

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 10; // x10 boost for low vol tab audio

    // Worklet for PCM16
    await this.audioContext.audioWorklet.addModule(URL.createObjectURL(new Blob([`
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.port.onmessage = (e) => {
            if (e.data === 'stop') {
              this.port.postMessage('stopped');
            }
          };
        }
        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (input.length > 0) {
            const inputData = input[0];
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
            }
            this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
            return true;
          }
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `], { type: 'application/javascript' })));

    this.processor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.processor);

    this.processor.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const pcmData = new Int16Array(e.data);
        for (let i = 0; i < pcmData.length; i++) {
          this.pcmBuffer[this.bufferIndex++] = pcmData[i];
          if (this.bufferIndex >= this.pcmBuffer.length) {
            const chunk = new ArrayBuffer(this.pcmBuffer.length * 2);
            new Int16Array(chunk).set(this.pcmBuffer);
            console.log('Chunk recibido para real-time: PCM16 50ms', chunk.byteLength, 'bytes');
            this.chunkSubject.next(new Blob([chunk], { type: 'audio/pcm' }));
            this.bufferIndex = 0;
          }
        }
      }
    };

    this.isRecording = true;
    console.log('Grabación real-time iniciada con PCM16 50ms chunks (gain x10)');
  }

  stopRecording() {
    if (this.processor) {
      this.processor.port.postMessage('stop');
    }
    if (this.source) {
      this.source.mediaStream.getTracks().forEach(track => track.stop());
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.isRecording = false;
    console.log('Captura detenida');
    this.chunkSubject.complete();
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