import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { PCM24To16, wav, validateWAV } from '../Backend/ModeAAdapter/audio.mjs';
import { credentialVerifier, validateSpeech, validateUpdate, configuration, PROFILE } from '../Backend/ModeAAdapter/protocol.mjs';
import { createAdapter, localUpstreams } from '../Backend/ModeAAdapter/server.mjs';
import { testIdentity, fakeSpeech } from '../Development/fakes.mjs';

export async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
export async function socket(address, credential) {
  const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${credential}` } });
  const messages = []; const readers = [];
  ws.on('message', raw => { const message = JSON.parse(raw); const reader = readers.shift(); reader ? reader.resolve(message) : messages.push(message); });
  ws.on('error', () => {});
  await once(ws, 'open');
  return { ws, send: m => ws.send(JSON.stringify(m)), async next() {
    if (messages.length) return messages.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for event')), 3000);
      readers.push({ resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  } };
}

test('stateful low-pass resampling is independent of chunk boundaries including odd bytes and final drain', () => {
  const input = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) input.writeInt16LE(Math.round(12000 * Math.sin(i * 0.19)), i * 2);
  const whole = new PCM24To16().push(input, true);
  for (const size of [1, 7, 511, 4800]) {
    const converter = new PCM24To16(), chunks = [];
    for (let p = 0; p < input.length; p += size) chunks.push(converter.push(input.subarray(p, p + size)));
    chunks.push(converter.push(Buffer.alloc(0), true)); assert.deepEqual(Buffer.concat(chunks), whole);
    assert.throws(() => converter.push(Buffer.alloc(0), true));
  }
  assert.equal(whole.length, 32000);
  const odd = new PCM24To16(); odd.push(Buffer.from([1])); assert.throws(() => odd.push(Buffer.alloc(0), true));
});
test('resampler suppresses energy above the 16 kHz Nyquist limit', () => {
  const input = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++) input.writeInt16LE(Math.round(16000 * Math.sin(2 * Math.PI * 10000 * i / 24000)), i * 2);
  const output = new PCM24To16().push(input, true); let energy = 0;
  for (let i = 100; i < output.length - 100; i += 2) energy += output.readInt16LE(i) ** 2;
  assert.ok(Math.sqrt(energy / (output.length / 2 - 100)) < 500);
});
test('offline credential verification fails closed for signature, expiry, audience, profile and call binding', () => {
  const id = testIdentity(), verify = credentialVerifier(id);
  assert.equal(verify(`Bearer ${id.issue('call_a')}`, 'call_a').call_id, 'call_a');
  for (const changes of [{ exp: 0 }, { aud: 'wrong' }, { profile: 'wrong' }, { v: 2 }, { binding: '' }, { device_id: null }, { jti: '' }, { iat: 9999999999 }]) assert.throws(() => verify(`Bearer ${id.issue('call_a', changes)}`));
  assert.throws(() => verify(`Bearer ${id.issue('call_b')}`, 'call_a'));
  assert.throws(() => verify(`Bearer ${testIdentity().issue('call_a')}`));
  assert.throws(() => verify('Bearer nonsense'));
});
test('adapter accepts the credential emitted by Switchboard v0.1.0 actual Signer', () => {
  const fixture = JSON.parse(readFileSync(new URL('../Fixtures/Speech-v1/switchboard-sbb1.json', import.meta.url)));
  const check = credentialVerifier({ publicKey: fixture.public_key, audience: fixture.claims.aud, clock: () => fixture.now_ms / 1000 });
  assert.deepEqual(check(`Bearer ${fixture.credential}`, 'call_fixture_contract'), fixture.claims);
  assert.throws(() => check(`Bearer ${fixture.credential}`, 'call_someone_else'));
  assert.throws(() => check(`Bearer ${fixture.credential.replace(/^sbb1/, 'sbb2')}`));
  const expired = credentialVerifier({ publicKey: fixture.public_key, audience: fixture.claims.aud, clock: () => fixture.claims.exp });
  assert.throws(() => expired(`Bearer ${fixture.credential}`));
});
test('session updates are strict and atomic; speech aliases and WAV media are validated', () => {
  assert.deepEqual(validateUpdate({ type: 'transcription' }), configuration());
  for (const update of [{ type: 'realtime' }, { type: 'transcription', tools: [] }, { type: 'transcription', audio: { input: { turn_detection: { type: 'server_vad' } } } }, { type: 'transcription', audio: { input: { format: { rate: 16000 } } } }]) assert.throws(() => validateUpdate(update));
  assert.deepEqual(configuration().audio.input.format, { type: 'audio/pcm', rate: 24000 });
  const body = { model: 'local-breeze', voice: 'local-default', input: 'Hello.', response_format: 'pcm' }; assert.equal(validateSpeech(body), body);
  for (const changes of [{ speed: 2 }, { model: 'provider-model' }, { voice: 'unknown' }, { input: '' }, { response_format: 'mp3' }]) assert.throws(() => validateSpeech({ ...body, ...changes }));
  const pcm = Buffer.alloc(480); const valid = wav(pcm); assert.deepEqual(validateWAV(valid), pcm);
  const wrong = Buffer.from(valid); wrong.writeUInt32LE(16000, 24); assert.throws(() => validateWAV(wrong));
  assert.throws(() => validateWAV(valid.subarray(0, 50)));
});
test('Realtime integration gates audio, hides partials, commits once and synthesizes independently', async t => {
  const identity = testIdentity(), upstreams = fakeSpeech();
  const adapter = createAdapter({ development: true, verifyCredential: credentialVerifier(identity), upstreams });
  const origin = await listen(adapter.server); t.after(() => adapter.close());
  const s = await socket(origin.replace('http', 'ws') + '/v1/realtime?intent=transcription', identity.issue('call_a'));
  assert.equal((await s.next()).type, 'session.created');
  s.send({ type: 'input_audio_buffer.append', audio: 'AAAA' }); assert.equal((await s.next()).type, 'error');
  s.send({ type: 'session.update', session: { type: 'transcription' } }); assert.equal((await s.next()).type, 'session.updated');
  for (let turn = 0; turn < 3; turn++) {
    s.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') });
    s.send({ type: 'input_audio_buffer.commit' });
    assert.equal((await s.next()).type, 'input_audio_buffer.committed');
    const done = await s.next(); assert.equal(done.type, 'conversation.item.input_audio_transcription.completed'); assert.equal(done.usage.seconds, 0.1);
  }
  assert.equal(upstreams.received.pcm.length, 3); assert.equal(upstreams.received.pcm[0].length, 3200);
  const result = await fetch(origin + '/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${identity.issue('call_a')}` }, body: JSON.stringify({ model: 'local-breeze', voice: 'local-default', input: 'Hello.', response_format: 'pcm' }) });
  assert.equal(result.status, 200); assert.equal((await result.arrayBuffer()).byteLength, 4800);
  assert.equal((await fetch(origin + '/v1/audio/speech', { method: 'POST', body: '{}' })).status, 401);
  assert.deepEqual(await (await fetch(origin + '/health')).json(), { status: 'ok' }); s.ws.close();
});
test('real upstream transport maps custom transcript events; abnormal close is never empty success', async t => {
  let abnormal = false, received = 0;
  const server = http.createServer((req, res) => { const data = wav(Buffer.alloc(4800)); res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(data); });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.on('message', (data, binary) => {
    if (binary) { received += data.length; return; }
    assert.equal(JSON.parse(data).type, 'input_audio.end');
    ws.send(JSON.stringify({ type: 'transcript.partial', text: 'Wrong partial' }));
    if (abnormal) ws.close(1011); else { ws.send(JSON.stringify({ type: 'transcript', text: 'Final.' })); ws.close(1000); }
  }));
  const origin = await listen(server); t.after(() => new Promise(resolve => { wss.close(); server.close(resolve); }));
  const upstream = localUpstreams({ parakeet: origin.replace('http', 'ws') + '/v1/transcribe', breeze: origin + '/v1/audio/speech' });
  const recognize = () => new Promise(resolve => { const stream = upstream.recognize(text => resolve({ text }), () => resolve({ failed: true })); stream.append(Buffer.alloc(3200)); stream.commit(); });
  assert.deepEqual(await recognize(), { text: 'Final.' }); assert.equal(received, 3200);
  abnormal = true; assert.deepEqual(await recognize(), { failed: true });
  assert.equal((await upstream.speech({ model: 'local-breeze', input: 'Hi.', response_format: 'pcm' })).length, 4800);
});

test('streamed PCM requires per-response format metadata and carries odd byte boundaries', async t => {
  let rate = '24000';
  const pcm = Buffer.alloc(4800, 1);
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts));
    if (body.response_format === 'wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav(pcm)); }
    else {
      res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': rate, 'x-sample-format': 's16le' });
      res.write(pcm.subarray(0, 3)); setImmediate(() => res.end(pcm.subarray(3)));
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.on('message', (_, binary) => { if (!binary) { ws.send(JSON.stringify({ type: 'transcript', text: '' })); ws.close(1000); } }));
  const origin = await listen(server); t.after(() => new Promise(resolve => { wss.close(); server.close(resolve); }));
  const upstream = localUpstreams({ parakeet: origin.replace('http', 'ws') + '/v1/transcribe', breeze: origin + '/v1/audio/speech' });
  const collect = async () => { const chunks = []; for await (const chunk of upstream.streamPCM({ model: 'local-breeze', input: 'Hello.' }, new AbortController().signal)) { assert.equal(chunk.length % 2, 0); chunks.push(chunk); } return Buffer.concat(chunks); };
  assert.deepEqual(await collect(), pcm); rate = '16000'; await assert.rejects(collect(), /format/);
});
