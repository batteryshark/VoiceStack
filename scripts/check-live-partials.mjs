// Local speech-only check. Never contacts Switchboard or sends an agent message.
import assert from 'node:assert/strict';
import { localUpstreams } from '../Backend/ModeAAdapter/server.mjs';
import { PCM24To16 } from '../Backend/ModeAAdapter/audio.mjs';
const upstream = localUpstreams();
const pcm = await upstream.speech({ model: 'local-breeze', input: 'This is a local caption test. The words should appear while I am still speaking, before this recording is sent.', response_format: 'pcm' });
const audio = new PCM24To16().push(pcm, true);
let committed = false, partials = 0, snapshots = 0, firstMs, firstSnapshotMs;
const started = performance.now();
let done, fail;
const result = new Promise((resolve, reject) => { done = resolve; fail = reject; });
const stream = upstream.recognize(done, () => fail(Error('Recognition failed')), delta => {
  if (!committed) { partials++; firstMs ??= Math.round(performance.now() - started); }
}, text => {
  if (!committed && text.trim()) { snapshots++; firstSnapshotMs ??= Math.round(performance.now() - started); }
});
try {
  for (let i = 0; i < audio.length; i += 3200) { stream.append(audio.subarray(i, i + 3200)); await new Promise(r => setTimeout(r, 100)); }
  assert.ok(partials > 0, 'No live captions arrived before commit');
  committed = true; stream.commit();
  const text = await result; assert.ok(text.length > 10);
  console.log(JSON.stringify({ passed: true, snapshotsBeforeCommit: snapshots, firstSnapshotMs, partialsBeforeCommit: partials, firstPartialMs: firstMs, audioMs: Math.round(audio.length / 32), finalCharacters: text.length }));
} finally { stream.cancel(); }
