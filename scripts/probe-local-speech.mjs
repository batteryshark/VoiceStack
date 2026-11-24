import { localUpstreams } from '../Backend/ModeAAdapter/server.mjs';
import { validateWAV } from '../Backend/ModeAAdapter/audio.mjs';
const services = localUpstreams();
const versions = {};
for (const [name, port] of [['parakeet', 8446], ['breeze', 8444]]) {
  const info = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })).json();
  versions[name] = { backend: info.backend, revision: info.revision, model_id: info.model_id, default_voice: info.default_voice };
}
const data = await services.speech({ model: 'local-breeze', voice: 'local-default', input: 'Voice Stack synthetic readiness check.', response_format: 'wav' });
const pcm = validateWAV(data);
const result = await new Promise((resolve, reject) => {
  const stream = services.recognize(text => { clearTimeout(timer); resolve({ normal_close: true, final_characters: text.length }); }, () => { clearTimeout(timer); reject(new Error('Parakeet did not complete normally')); });
  const timer = setTimeout(() => { stream.cancel(); reject(new Error('Parakeet timeout')); }, 30000);
  stream.append(Buffer.alloc(16000 * 2)); stream.commit();
});
let streamedBytes = 0;
for await (const chunk of services.streamPCM({ model: 'local-breeze', input: 'Synthetic streaming format check.', response_format: 'pcm' }, new AbortController().signal)) streamedBytes += chunk.length;
console.log(JSON.stringify({ versions, speech: { wav_valid: true, rate: 24000, channels: 1, pcm_bytes: pcm.length, streamed_pcm_bytes: streamedBytes }, transcription: result }, null, 2));
