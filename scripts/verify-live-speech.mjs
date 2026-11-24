// Synthetic audio only. Pipe the operator's pairing-code JSON into stdin; never
// pass credentials as arguments or write them to disk. No microphone use.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const base = process.env.VOICE_SWITCHBOARD_BASE;
assert.ok(base?.startsWith('https://'), 'VOICE_SWITCHBOARD_BASE must be HTTPS');
let input = ''; for await (const part of process.stdin) input += part;
const { pairing_code } = JSON.parse(input); input = '';
let credential, call, speech, text;
const installation = randomUUID();
async function request(method, path, body) {
  const r = await fetch(`${base}/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(40000),
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: body && JSON.stringify(body) });
  assert.ok(r.ok, `${path}: HTTP ${r.status}`); return r.json();
}
function connect(url, secret) {
  assert.equal(new URL(url).protocol, 'wss:');
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` }, handshakeTimeout: 10000 });
  const frames = []; let failure;
  ws.on('message', raw => frames.push(JSON.parse(raw)));
  ws.on('error', () => { failure = new Error('WebSocket failed'); });
  ws.on('close', () => { failure ??= new Error('WebSocket closed'); });
  return { close: () => ws.close(), send: frame => ws.send(JSON.stringify(frame)), async wait(type, extra = () => true) {
    const limit = Date.now() + 40000;
    while (Date.now() < limit) {
      const i = frames.findIndex(f => f.type === type && extra(f));
      if (i >= 0) return frames.splice(i, 1)[0];
      assert.ok(!frames.some(f => f.type === 'error' || f.type.endsWith('.failed')), 'Protocol error');
      if (failure) throw failure;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`Timed out: ${type}`);
  } };
}
async function synthesize(backend, input) {
  const r = await fetch(backend.speech_address, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(40000),
    headers: { authorization: `Bearer ${backend.credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-breeze', voice: 'local-default', input, response_format: 'pcm' }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/pcm');
  const pcm = Buffer.from(await r.arrayBuffer()); assert.ok(pcm.length > 0 && pcm.length % 2 === 0); return pcm;
}
try {
  const paired = await request('POST', 'pair', { profile: 'voicestack-app/1', pairing_code,
    device: { installation_id: installation, name: 'Synthetic Mac speech verifier', platform: 'macos', app_version: '0.1.0' } });
  credential = paired.device_credential;
  await request('POST', 'pair/ack', { operation_id: randomUUID(), installation_id: installation });
  assert.equal((await request('GET', 'me')).acknowledged, true);
  const targets = (await request('GET', 'targets')).targets;
  const admitted = await request('POST', 'calls', { operation_id: randomUUID(), direction: 'outgoing', target_id: targets.find(t => t.is_default && t.available).id });
  call = admitted.call;
  text = connect(call.text_channel, credential);
  assert.equal((await text.wait('call.ready')).target_binding, call.target_binding);
  for (let i = 0; i < 3; i++) {
    const { backend } = await request('POST', `calls/${call.id}/backend-handoff`, { operation_id: randomUUID() });
    const pcm = await synthesize(backend, `This is voice stack test number ${i + 1}. Please confirm receipt.`);
    speech = connect(backend.transcription_address, backend.credential);
    await speech.wait('session.created'); speech.send({ type: 'session.update', session: { type: 'transcription' } }); await speech.wait('session.updated');
    for (let p = 0; p < pcm.length; p += 4800) speech.send({ type: 'input_audio_buffer.append', audio: pcm.subarray(p, p + 4800).toString('base64') });
    speech.send({ type: 'input_audio_buffer.commit' });
    const transcript = await speech.wait('conversation.item.input_audio_transcription.completed');
    assert.ok(transcript.transcript.trim().length > 0); speech.close(); speech = null;
    const operation = randomUUID();
    text.send({ type: 'turn.submit', operation_id: operation, text: transcript.transcript, delivery: 'steer' });
    const accepted = await text.wait('turn.accepted', f => f.operation_id === operation);
    assert.equal(accepted.target_binding, call.target_binding);
    const reply = await text.wait('reply.done', f => f.response_id === accepted.response_id);
    assert.equal(reply.status, 'completed'); assert.ok(reply.text);
    const output = await synthesize(backend, reply.text);
    console.log(JSON.stringify({ turn: i + 1, call_id: call.id, input_pcm_bytes: pcm.length, transcript_characters: transcript.transcript.length, effective_delivery: accepted.effective_delivery, output_pcm_bytes: output.length, completed: true }));
  }
} finally {
  speech?.close(); text?.close();
  if (call) { await request('POST', `calls/${call.id}/end`, { operation_id: randomUUID(), reason: 'user' }); console.log('Synthetic speech verification call ended.'); }
}
