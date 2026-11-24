import { Fault } from './protocol.mjs';

// Windowed-sinc anti-alias filter, sampled at rational 3/2 positions. Keep history,
// phase and a possible trailing byte across append boundaries. Drain exactly once.
export class PCM24To16 {
  samples = []; base = 0; total = 0; next = 0; odd = Buffer.alloc(0); ended = false;
  radius = 24;
  push(bytes, final = false) {
    if (this.ended) throw new Fault('validation_error', 'Audio already drained');
    bytes = Buffer.concat([this.odd, bytes]);
    this.odd = bytes.subarray(bytes.length - (bytes.length % 2));
    for (let i = 0; i + 1 < bytes.length; i += 2) { this.samples.push(bytes.readInt16LE(i)); this.total++; }
    if (final && this.odd.length) throw new Fault('validation_error', 'Incomplete PCM sample');
    const out = [];
    while (this.next * 1.5 < this.total && (final || this.next * 1.5 + this.radius < this.total)) {
      const position = this.next * 1.5;
      let sum = 0, weights = 0;
      for (let n = Math.ceil(position - this.radius); n <= Math.floor(position + this.radius); n++) {
        const x = n - position;
        const cutoff = 0.62;
        const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
        const w = sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / this.radius));
        const index = Math.max(0, Math.min(this.total - 1, n));
        sum += (this.samples[index - this.base] ?? 0) * w; weights += w;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(sum / weights)))); this.next++;
    }
    const discard = Math.max(0, Math.floor(this.next * 1.5) - this.radius - this.base);
    this.samples.splice(0, discard); this.base += discard;
    this.ended = final;
    const result = Buffer.alloc(out.length * 2);
    out.forEach((sample, i) => result.writeInt16LE(sample, i * 2)); return result;
  }
}
export function validateWAV(data) {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt32LE(4) + 8 !== data.length) throw new Fault('backend_unavailable', 'Invalid speech WAV', 502);
  let format = false, pcm;
  for (let p = 12; p + 8 <= data.length;) {
    const kind = data.toString('ascii', p, p + 4), size = data.readUInt32LE(p + 4); p += 8;
    if (p + size > data.length) throw new Fault('backend_unavailable', 'Truncated speech WAV', 502);
    if (kind === 'fmt ') {
      if (size < 16 || data.readUInt16LE(p) !== 1 || data.readUInt16LE(p + 2) !== 1 || data.readUInt32LE(p + 4) !== 24000 || data.readUInt32LE(p + 8) !== 48000 || data.readUInt16LE(p + 12) !== 2 || data.readUInt16LE(p + 14) !== 16) throw new Fault('backend_unavailable', 'Speech must be mono 24 kHz PCM16', 502);
      format = true;
    }
    if (kind === 'data') pcm = data.subarray(p, p + size);
    p += size + size % 2;
  }
  if (!format || !pcm?.length || pcm.length % 2) throw new Fault('backend_unavailable', 'Missing or invalid WAV audio', 502);
  return pcm;
}
export function wav(pcm) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
