class PetMicrophone extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(1024); this.position = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.samples[this.position++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
      if (this.position === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(1024); this.position = 0;
      }
    }
    return true;
  }
}
registerProcessor('pet-microphone', PetMicrophone);
