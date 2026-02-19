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

  private chunkSubject = new Subject<ArrayBuffer>();
  chunk$ = this.chunkSubject.asObservable();

  private pcmBuffer = new Int16Array(800); // 50ms a 16kHz
  private bufferIndex = 0;
  private chunksReceived = 0;
  private lastVoiceTime = 0;
  private readonly SILENCE_LOG_THRESHOLD = 3000;

  async startTabAudioCapture() {
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

    // Gain x12 — audio de pestaña del navegador viene muy bajo (-50 a -80dB)
    // Necesita boost agresivo para que AssemblyAI detecte voz
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 12;

    // Compresor más agresivo para normalizar dinámicas
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -30;
    this.compressor.knee.value = 6;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.001;
    this.compressor.release.value = 0.05;

    console.log('🔊 Audio: Gain x12 + Compresor ratio:8');

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

          const audioBuffer = new ArrayBuffer(chunk.byteLength);
          new Int16Array(audioBuffer).set(chunk);
          this.chunkSubject.next(audioBuffer);

          if (this.chunksReceived % 20 === 0) {
            const level = this.calculateAudioLevel(chunk);
            const now = Date.now();
            if (level > -40) this.lastVoiceTime = now;
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

//   // Se recrea en cada startTabAudioCapture() — NUNCA se llama .complete()
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

//     // Gain x3 — conservador para no clipear el audio (x50 anterior saturaba el VAD)
//     this.gainNode = this.audioContext.createGain();
//     this.gainNode.gain.value = 3;

//     // Compresor conservador — normaliza dinámica sin distorsionar
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

//     // NO llamar .complete() — causa que chunk$ nunca emita en la siguiente grabación
//     // El Subject muere silenciosamente cuando se pierde la referencia.

//     this.bufferIndex = 0;
//     this.chunksReceived = 0;
//     console.log('🛑 Captura detenida');
//   }
// }

