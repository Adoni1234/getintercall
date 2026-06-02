
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

  // FIX #1: 4800 samples = 300ms @ 16kHz
  // Con 100ms (1600) los chunks eran demasiado pequeños y AAI no tenía
  // contexto suficiente para detectar el idioma ni las palabras correctamente.
  // 300ms es el mínimo recomendado para AssemblyAI v3 streaming multilingüe.
  private pcmBuffer = new Int16Array(4800);
  private bufferIndex = 0;
  private chunksReceived = 0;

  async startTabAudioCapture() {
    this.chunkSubject = new Subject<ArrayBuffer>();
    this.chunk$ = this.chunkSubject.asObservable();

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

      stream.getVideoTracks().forEach(track => track.enabled = false);
    } catch (err: any) {
      throw new Error(`Screen capture falló: ${err.name}. Usa Chrome + HTTPS.`);
    }

    if (stream.getAudioTracks().length === 0) {
      throw new Error('Stream sin audio tracks — marca "Compartir audio"');
    }

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(stream);

    // Gain moderado para no saturar antes del compresor.
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 2;

    // Compresor como limitador de picos.
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -20;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.001;
    this.compressor.release.value = 0.05;

    await this.audioContext.audioWorklet.addModule(
      URL.createObjectURL(new Blob([`
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            // Normalizador adaptativo per-chunk:
            // Mantiene el nivel promedio de los últimos N chunks para
            // amplificar voces débiles sin saturar voces fuertes.
            this._recentPeaks = new Float32Array(8);
            this._peakIdx = 0;
          }

          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              const inputData = input[0];

              // Calcular peak del chunk actual
              let peak = 0;
              for (let i = 0; i < inputData.length; i++) {
                const abs = Math.abs(inputData[i]);
                if (abs > peak) peak = abs;
              }

              // Actualizar ventana de peaks recientes
              this._recentPeaks[this._peakIdx] = peak;
              this._peakIdx = (this._peakIdx + 1) % this._recentPeaks.length;

              // Peak máximo de la ventana (últimos ~8 chunks)
              let windowPeak = 0;
              for (let i = 0; i < this._recentPeaks.length; i++) {
                if (this._recentPeaks[i] > windowPeak) windowPeak = this._recentPeaks[i];
              }

              // FIX #2: Ganancia máxima reducida de 8x a 4x para evitar distorsión
              // que causa que AAI no reconozca fonemas. El techo de 0.65 (antes 0.7)
              // deja un poco más de headroom antes de saturar.
              let gain = 1.0;
              if (windowPeak > 0.001) {
                gain = Math.min(4.0, Math.max(1.0, 0.65 / windowPeak));
              } else {
                gain = 4.0; // silencio total → ganancia máxima reducida
              }

              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                const amplified = Math.max(-1, Math.min(1, inputData[i] * gain));
                pcm16[i] = amplified < 0 ? amplified * 32768 : amplified * 32767;
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

    this.chunksReceived = 0;

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

          // Sin noise gate — AssemblyAI v3 tiene VAD interno.
          const audioBuffer = new ArrayBuffer(chunk.byteLength);
          new Int16Array(audioBuffer).set(chunk);
          this.chunkSubject.next(audioBuffer);

          if (this.chunksReceived % 10 === 0) {
            // Log cada 10 chunks (cada 3s con chunks de 300ms)
            const level = this.calculateRMS(chunk);
            console.log(`🎤 Chunk #${this.chunksReceived}: ${level.toFixed(1)} dB`);
          }
        }
      }
    };

    this.isRecording = true;
    console.log('✅ Grabación iniciada — chunks 300ms hacia AssemblyAI');
  }

  private calculateRMS(buffer: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = buffer[i] / 32768;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / buffer.length);
    if (rms === 0) return -100;
    return 20 * Math.log10(rms);
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    if (this.processor)   { this.processor.disconnect(); this.processor = null; }
    if (this.source)      { this.source.mediaStream.getTracks().forEach(t => t.stop()); this.source.disconnect(); this.source = null; }
    if (this.gainNode)    { this.gainNode.disconnect(); this.gainNode = null; }
    if (this.compressor)  { this.compressor.disconnect(); this.compressor = null; }
    if (this.audioContext){ this.audioContext.close(); this.audioContext = null; }

    this.chunksReceived = 0;
    this.bufferIndex = 0;
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

//   private chunkSubject = new Subject<ArrayBuffer>();
//   chunk$ = this.chunkSubject.asObservable();

//   // 1600 samples = 100ms @ 16kHz — tamaño estable para AssemblyAI v3
//   private pcmBuffer = new Int16Array(1600);
//   private bufferIndex = 0;
//   private chunksReceived = 0;

//   async startTabAudioCapture() {
//     this.chunkSubject = new Subject<ArrayBuffer>();
//     this.chunk$ = this.chunkSubject.asObservable();

//     let stream: MediaStream;

//     try {
//       stream = await navigator.mediaDevices.getDisplayMedia({
//         video: true,
//         audio: {
//           echoCancellation: false,
//           noiseSuppression: false,
//           autoGainControl: false,
//           sampleRate: 16000,
//         } as any,
//       });

//       stream.getVideoTracks().forEach(track => track.enabled = false);
//     } catch (err: any) {
//       throw new Error(`Screen capture falló: ${err.name}. Usa Chrome + HTTPS.`);
//     }

//     if (stream.getAudioTracks().length === 0) {
//       throw new Error('Stream sin audio tracks — marca "Compartir audio"');
//     }

//     this.audioContext = new AudioContext({ sampleRate: 16000 });
//     this.source = this.audioContext.createMediaStreamSource(stream);

//     // Gain bajo (2) para no saturar antes del compresor.
//     // La amplificación real se hace en el AudioWorklet con normalización per-chunk.
//     this.gainNode = this.audioContext.createGain();
//     this.gainNode.gain.value = 2;

//     // Compresor solo como limitador de picos — NO como amplificador.
//     // threshold alto (-20dB): solo actúa en picos muy fuertes.
//     // ratio bajo (3): compresión suave sin matar voces débiles.
//     // release rápido (0.05s): se recupera antes del siguiente hablante.
//     this.compressor = this.audioContext.createDynamicsCompressor();
//     this.compressor.threshold.value = -20;
//     this.compressor.knee.value = 10;
//     this.compressor.ratio.value = 3;
//     this.compressor.attack.value = 0.001;
//     this.compressor.release.value = 0.05;

//     await this.audioContext.audioWorklet.addModule(
//       URL.createObjectURL(new Blob([`
//         class PCMProcessor extends AudioWorkletProcessor {
//           constructor() {
//             super();
//             // Normalizador adaptativo per-chunk:
//             // Mantiene el nivel promedio de los últimos N chunks para
//             // amplificar voces débiles sin saturar voces fuertes.
//             this._recentPeaks = new Float32Array(8);
//             this._peakIdx = 0;
//           }

//           process(inputs) {
//             const input = inputs[0];
//             if (input && input[0]) {
//               const inputData = input[0];

//               // Calcular peak del chunk actual
//               let peak = 0;
//               for (let i = 0; i < inputData.length; i++) {
//                 const abs = Math.abs(inputData[i]);
//                 if (abs > peak) peak = abs;
//               }

//               // Actualizar ventana de peaks recientes
//               this._recentPeaks[this._peakIdx] = peak;
//               this._peakIdx = (this._peakIdx + 1) % this._recentPeaks.length;

//               // Peak máximo de la ventana (últimos ~8 chunks = ~800ms)
//               let windowPeak = 0;
//               for (let i = 0; i < this._recentPeaks.length; i++) {
//                 if (this._recentPeaks[i] > windowPeak) windowPeak = this._recentPeaks[i];
//               }

//               // Ganancia adaptativa: normalizar al 70% del rango máximo.
//               // Si el audio es muy bajo (peak < 0.001) usar ganancia máxima de 8x.
//               // Si el audio es normal, ganancia = 0.7 / windowPeak (máx 8x, mín 1x).
//               let gain = 1.0;
//               if (windowPeak > 0.001) {
//                 gain = Math.min(8.0, Math.max(1.0, 0.7 / windowPeak));
//               } else {
//                 gain = 8.0; // silencio total → ganancia máxima para capturar susurros
//               }

//               const pcm16 = new Int16Array(inputData.length);
//               for (let i = 0; i < inputData.length; i++) {
//                 const amplified = Math.max(-1, Math.min(1, inputData[i] * gain));
//                 pcm16[i] = amplified < 0 ? amplified * 32768 : amplified * 32767;
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

//     this.chunksReceived = 0;

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

//           // ── Sin noise gate ─────────────────────────────────────────────
//           // AssemblyAI v3 tiene VAD interno. Filtrar en el cliente causa
//           // pérdida de voz suave (doctor). Enviamos TODO el audio siempre.
//           // AAI decide qué es silencio y qué es voz.
//           const audioBuffer = new ArrayBuffer(chunk.byteLength);
//           new Int16Array(audioBuffer).set(chunk);
//           this.chunkSubject.next(audioBuffer);

//           if (this.chunksReceived % 20 === 0) {
//             const level = this.calculateRMS(chunk);
//             console.log(`🎤 Chunk #${this.chunksReceived}: ${level.toFixed(1)} dB`);
//           }
//         }
//       }
//     };

//     this.isRecording = true;
//     console.log('✅ Grabación iniciada — audio completo hacia AssemblyAI (chunks 100ms)');
//   }

//   private calculateRMS(buffer: Int16Array): number {
//     let sum = 0;
//     for (let i = 0; i < buffer.length; i++) {
//       const normalized = buffer[i] / 32768;
//       sum += normalized * normalized;
//     }
//     const rms = Math.sqrt(sum / buffer.length);
//     if (rms === 0) return -100;
//     return 20 * Math.log10(rms);
//   }

//   stopRecording() {
//     if (!this.isRecording) return;
//     this.isRecording = false;

//     if (this.processor)   { this.processor.disconnect(); this.processor = null; }
//     if (this.source)      { this.source.mediaStream.getTracks().forEach(t => t.stop()); this.source.disconnect(); this.source = null; }
//     if (this.gainNode)    { this.gainNode.disconnect(); this.gainNode = null; }
//     if (this.compressor)  { this.compressor.disconnect(); this.compressor = null; }
//     if (this.audioContext){ this.audioContext.close(); this.audioContext = null; }

//     this.chunksReceived = 0;
//     this.bufferIndex = 0;
//     console.log('🛑 Captura detenida');
//   }
// }
