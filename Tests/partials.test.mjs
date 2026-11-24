import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { localUpstreams, createAdapter } from '../Backend/ModeAAdapter/server.mjs';
import { StablePartial } from '../Backend/ModeAAdapter/partials.mjs';
import { credentialVerifier } from '../Backend/ModeAAdapter/protocol.mjs';
import { testIdentity } from '../Development/fakes.mjs';

test('replacement hypotheses never duplicate words as additive deltas', () => {
  const p = new StablePartial();
  assert.equal(p.append('Hello Mar'), '');
  assert.equal(p.append('Hello Robin this'), 'Hello ');
  assert.equal(p.append('Hello Robin there'), 'Robin ');
  assert.equal(p.append('Hello Maria there is'), '');
  assert.equal(p.append('Hello Robin there is more'), '');
  assert.equal(p.append('Hello Robin there is more text'), 'there is ');
});

for (const snapshots of [false, true]) test(`upstream-to-Realtime ${snapshots ? 'full snapshot' : 'standard delta'} before commit; discard fences old callbacks`, async t => {
  const source = http.createServer(), wss = new WebSocketServer({ server: source });
  let commits = 0;
  wss.on('connection', (ws, req) => {
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('partials'), '1');
    ws.on('message', (_, binary) => {
      if (binary) {
        ws.send(JSON.stringify({ type: 'transcript.partial', text: 'Hello Robin' }));
        ws.send(JSON.stringify({ type: 'transcript.partial', text: 'Hello Robin this is a test' }));
      } else { commits++; ws.send(JSON.stringify({ type: 'transcript', text: 'Final corrected words.' })); ws.close(1000); }
    });
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); source.close(); });
  const id = testIdentity();
  const adapter = createAdapter({ development: true, verifyCredential: credentialVerifier(id), upstreams: localUpstreams({ parakeet: `ws://127.0.0.1:${source.address().port}/v1/transcribe` }) });
  adapter.server.listen(0, '127.0.0.1'); await once(adapter.server, 'listening'); t.after(() => adapter.close());
  const ws = new WebSocket(`ws://127.0.0.1:${adapter.server.address().port}/v1/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${id.issue('call_preview')}`, ...(snapshots ? { 'X-VoiceStack-Live-Preview': 'snapshots-v1' } : {}) } });
  const queue = [], waiters = [];
  ws.on('message', raw => { const m = JSON.parse(raw); const f = waiters.shift(); f ? f(m) : queue.push(m); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('No live transcript before commit')), 1500); waiters.push(m => { clearTimeout(timer); resolve(m); }); });
  const send = m => ws.send(JSON.stringify(m));
  await once(ws, 'open'); await next(); send({ type: 'session.update', session: { type: 'transcription' } }); await next();
  send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') });
  const partial = await next(); assert.equal(partial.type, snapshots ? 'voicestack.input_audio_transcription.preview' : 'conversation.item.input_audio_transcription.delta');
  if (snapshots) { assert.equal(partial.text, 'Hello Robin'); assert.equal((await next()).text, 'Hello Robin this is a test'); }
  else assert.equal(partial.delta, 'Hello ');
  assert.equal(commits, 0);
  send({ type: 'input_audio_buffer.clear' }); assert.equal((await next()).type, 'input_audio_buffer.cleared');
  send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') });
  const fresh = await next(); assert.notEqual(fresh.item_id, partial.item_id); if (snapshots) await next();
  send({ type: 'input_audio_buffer.commit' }); assert.equal((await next()).type, 'input_audio_buffer.committed');
  let final = await next();
  while (final.type === 'voicestack.input_audio_transcription.preview') { assert.equal(final.item_id, fresh.item_id); final = await next(); }
  assert.equal(final.type, 'conversation.item.input_audio_transcription.completed'); assert.equal(final.item_id, fresh.item_id); assert.equal(final.transcript, 'Final corrected words.'); assert.equal(commits, 1); ws.close();
});
