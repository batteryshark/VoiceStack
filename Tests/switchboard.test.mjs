import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSwitchboard } from '../Development/switchboard.mjs';
import { testIdentity, fakeSpeech } from '../Development/fakes.mjs';
import { createAdapter } from '../Backend/ModeAAdapter/server.mjs';
import { credentialVerifier } from '../Backend/ModeAAdapter/protocol.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function socket(address, token) {
  const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${token}` } }), queue = [], waiters = [];
  ws.on('message', raw => { const m = JSON.parse(raw); waiters.length ? waiters.shift()(m) : queue.push(m); });
  await once(ws, 'open');
  return { ws, send: m => ws.send(JSON.stringify(m)), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('event timeout')), 3000); waiters.push(m => { clearTimeout(timer); resolve(m); }); }) };
}
async function setup(t) {
  const id = testIdentity(), upstream = fakeSpeech(), adapter = createAdapter({ development: true, verifyCredential: credentialVerifier(id), upstreams: upstream });
  const speechOrigin = await listen(adapter.server);
  const board = createSwitchboard({ issueCredential: call => id.issue(call), speechOrigin }); const origin = await listen(board.server); board.setOrigin(origin);
  t.after(async () => { await board.close(); await adapter.close(); });
  async function request(token, method, path, body) {
    const res = await fetch(origin + '/voicestack/v1' + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  }
  async function pair(platform) {
    const installation_id = randomUUID();
    const p = await request(null, 'POST', '/pair', { profile: 'voicestack-app/1', pairing_code: `fixture-one-use-code-${platform === 'ios' ? 'ios' : 'mac'}`, device: { installation_id, name: platform, platform, app_version: '0.1' } });
    assert.equal(p.status, 200); const token = p.data.device_credential;
    const ack = { operation_id: randomUUID(), installation_id }; board.state.dropNext = true;
    await assert.rejects(request(token, 'POST', '/pair/ack', ack));
    assert.equal((await request(token, 'GET', '/me')).data.acknowledged, true);
    assert.equal((await request(token, 'POST', '/pair/ack', ack)).status, 200);
    return token;
  }
  const mac = await pair('macos'), phone = await pair('ios');
  return { board, origin, speechOrigin, request, mac, phone, upstream };
}
const mutation = fields => ({ operation_id: randomUUID(), ...fields });

test('caller-token lifecycle, call-only scope, last-use, revoke and delete preserve a placed call', async t => {
  const { request, mac } = await setup(t);
  const created = await request(mac, 'POST', '/caller-tokens', mutation({ name: 'Agent' })); assert.equal(created.status, 200);
  const { token, secret } = created.data;
  assert.equal((await request(secret, 'GET', '/targets')).status, 403);
  assert.equal((await request(mac, 'DELETE', `/caller-tokens/${token.id}`, mutation({}))).data.error.code, 'token_active');
  const placed = await request(secret, 'POST', '/calls', mutation({ direction: 'incoming', subject: 'Synthetic question' })); assert.equal(placed.status, 200);
  const listed = (await request(mac, 'GET', '/caller-tokens')).data.tokens[0]; assert.ok(listed.last_used_at); assert.equal(listed.secret, undefined);
  await request(mac, 'POST', `/caller-tokens/${token.id}/revoke`, mutation({}));
  assert.equal((await request(secret, 'POST', '/calls', mutation({ direction: 'incoming', subject: 'Again' }))).data.error.code, 'token_revoked');
  assert.equal((await request(mac, 'GET', `/calls/${placed.data.call.id}`)).data.call.state, 'ringing');
  assert.equal((await request(mac, 'DELETE', `/caller-tokens/${token.id}`, mutation({}))).status, 204);
  assert.deepEqual((await request(mac, 'GET', '/caller-tokens')).data.tokens, []);
});
test('first answer wins; restrictive phone policy ends presentation on both devices', async t => {
  const { request, origin, mac, phone } = await setup(t);
  const a = await socket(origin.replace('http', 'ws') + '/voicestack/v1/device/events', mac);
  const b = await socket(origin.replace('http', 'ws') + '/voicestack/v1/device/events', phone);
  assert.equal((await a.next()).type, 'device.ready'); await b.next();
  const secret = (await request(mac, 'POST', '/caller-tokens', mutation({ name: 'Agent' }))).data.secret;
  const ring = (await request(secret, 'POST', '/calls', mutation({ direction: 'incoming', subject: 'Ownership check' }))).data.call;
  assert.equal((await a.next()).call.id, ring.id); assert.equal((await b.next()).call.id, ring.id);
  assert.equal((await request(mac, 'POST', `/calls/${ring.id}/accept`, mutation({}))).status, 200);
  assert.equal((await b.next()).type, 'call.taken');
  assert.equal((await request(phone, 'POST', `/calls/${ring.id}/accept`, mutation({}))).data.error.code, 'call_taken');
  await request(secret, 'POST', '/calls', mutation({ direction: 'incoming', subject: 'Focus check' })); await a.next(); await b.next();
  assert.equal((await request(phone, 'PUT', '/devices/me/availability', mutation({ calls_allowed: false, reason: 'focus', valid_until: new Date(Date.now() + 60000).toISOString() }))).status, 200);
  assert.equal((await a.next()).type, 'call.ended'); assert.equal((await b.next()).type, 'call.ended');
  assert.equal((await request(mac, 'GET', `/calls/${ring.id}`)).data.call.state, 'connecting');
  a.ws.close(); b.ws.close();
});
test('admitted mutations reconcile with same ID; changed body conflicts and binding stays pinned', async t => {
  const { request, mac, board } = await setup(t);
  const body = mutation({ direction: 'outgoing', target_id: 'target_main' }); board.state.dropNext = true;
  await assert.rejects(request(mac, 'POST', '/calls', body));
  const accepted = await request(mac, 'POST', '/calls', body); assert.equal(accepted.status, 200); assert.equal(board.state.calls.size, 1);
  assert.equal((await request(mac, 'POST', '/calls', { ...body, target_id: 'target_fixture_project' })).data.error.code, 'operation_conflict');
  board.state.setMainBinding('new_pointer');
  assert.equal((await request(mac, 'GET', `/calls/${accepted.data.call.id}`)).data.call.target_binding, accepted.data.call.target_binding);
  const tokenBody = mutation({ name: 'Agent' }); board.state.dropNext = true; await assert.rejects(request(mac, 'POST', '/caller-tokens', tokenBody));
  const token = (await request(mac, 'POST', '/caller-tokens', tokenBody)).data.token; assert.equal(board.state.tokens.size, 1);
  for (const [method, path, fields] of [
    ['POST', `/caller-tokens/${token.id}/revoke`, {}], ['DELETE', `/caller-tokens/${token.id}`, {}],
    ['POST', `/calls/${accepted.data.call.id}/backend-handoff`, {}], ['POST', `/calls/${accepted.data.call.id}/end`, { reason: 'user' }]
  ]) {
    const op = mutation(fields); board.state.dropNext = true; await assert.rejects(request(mac, method, path, op));
    assert.ok([200, 204].includes((await request(mac, method, path, op)).status));
  }
});
test('three complete synthetic exchanges: audio → app → text channel → app → speech; Steer fallback never replays', async t => {
  const { request, mac, board, upstream } = await setup(t);
  const envelope = (await request(mac, 'POST', '/calls', mutation({ direction: 'outgoing', target_id: 'target_main' }))).data;
  const text = await socket(envelope.call.text_channel, mac), speech = await socket(envelope.backend.transcription_address, envelope.backend.credential);
  assert.equal((await text.next()).type, 'call.ready'); assert.equal((await speech.next()).type, 'session.created');
  speech.send({ type: 'session.update', session: { type: 'transcription' } }); assert.equal((await speech.next()).type, 'session.updated');
  for (let i = 0; i < 3; i++) {
    speech.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }); speech.send({ type: 'input_audio_buffer.commit' });
    assert.equal((await speech.next()).type, 'input_audio_buffer.committed'); assert.equal(board.state.calls.get(envelope.call.id).turns.size, i);
    const transcript = await speech.next(); assert.equal(transcript.type, 'conversation.item.input_audio_transcription.completed');
    const turn = { type: 'turn.submit', ...mutation({ text: transcript.transcript, delivery: 'steer' }) }; text.send(turn);
    const ack = await text.next(); assert.equal(ack.effective_delivery, 'queue'); await text.next(); const reply = await text.next();
    const audio = await fetch(envelope.backend.speech_address, { method: 'POST', headers: { Authorization: `Bearer ${envelope.backend.credential}` }, body: JSON.stringify({ model: 'local-breeze', voice: 'local-default', input: reply.text, response_format: 'pcm' }) });
    assert.equal(audio.status, 200); assert.equal((await audio.arrayBuffer()).byteLength, 4800);
    text.send(turn); assert.equal((await text.next()).response_id, ack.response_id); assert.equal(board.state.calls.get(envelope.call.id).turns.size, i + 1);
    text.send({ ...turn, text: 'Changed' }); assert.equal((await text.next()).error.code, 'operation_conflict');
  }
  assert.equal(upstream.received.speech.length, 3); assert.equal(upstream.received.pcm.length, 3); text.ws.close(); speech.ws.close();
});
