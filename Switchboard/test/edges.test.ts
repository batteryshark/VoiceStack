// Edge cases of the Switchboard server beyond the frozen contract walk: authorization, validation, idempotency,
// ring timeout, readiness and revoked-token behaviour. Real HTTP, WebSockets and SQLite through the shared harness.
import { afterEach, describe, expect, test } from 'bun:test';
import { harness, uuid, type Harness } from './harness.ts';
import type { StubDevice } from '../src/stubs/devices.ts';

let h: Harness;
afterEach(() => h?.stop());

/** A raw request with an explicit bearer (or none), for callers that are not StubDevices. */
async function raw(method: string, path: string, bearer: string | null, body?: unknown) {
  const response = await fetch(`${h.appBase}${path}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  h = await harness();
  const mac = await h.pairedDevice('macos', 'Mac');
  const phone = await h.pairedDevice('ios', 'iPhone');
  return { mac, phone };
}

async function makeToken(device: StubDevice, name = 'Agent') {
  const created = await device.request('POST', '/caller-tokens', { operation_id: uuid(), name });
  expect(created.status).toBe(200);
  return { id: created.body.token.id as string, secret: created.body.secret as string };
}

const place = (secret: string, extra: Record<string, unknown> = {}) =>
  raw('POST', '/calls', secret, { operation_id: uuid(), direction: 'incoming', subject: 'Review', ...extra });

describe('(a) authorization', () => {
  test('no bearer is 401 unauthorized', async () => {
    await setup();
    for (const [method, path, body] of [['GET', '/targets'], ['GET', '/caller-tokens'], ['GET', '/me'], ['POST', '/calls', { operation_id: uuid(), direction: 'incoming', subject: 'x' }]] as const) {
      const res = await raw(method, path, null, body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
    expect((await raw('GET', '/targets', 'sbd_notarealcredential')).status).toBe(401);
  });

  test('a caller token is 403 forbidden on GET /caller-tokens, GET /targets and POST accept', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    for (const [method, path] of [['GET', '/caller-tokens'], ['GET', '/targets']] as const) {
      const res = await raw(method, path, token.secret);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    const placed = await place(token.secret);
    expect(placed.status).toBe(200);
    const accept = await raw('POST', `/calls/${placed.body.call.id}/accept`, token.secret, { operation_id: uuid() });
    expect(accept.status).toBe(403);
    expect(accept.body.error.code).toBe('forbidden');
  });

  test('a caller token is 403 forbidden on the device-events WebSocket', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const url = `${h.appBase.replace(/^http/, 'ws')}/device/events`;
    const plain = await fetch(url.replace(/^ws/, 'http'), { headers: { authorization: `Bearer ${token.secret}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    expect(plain.status).toBe(403);
    expect((await plain.json()).error.code).toBe('forbidden');
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token.secret}` } } as unknown as string[]);
    const outcome = await new Promise<string>(resolve => { ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); ws.onclose = () => resolve('closed'); });
    expect(outcome).not.toBe('open');
  });

  test('a caller token sending direction outgoing is forbidden', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const res = await raw('POST', '/calls', token.secret, { operation_id: uuid(), direction: 'outgoing', subject: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  test('an unacknowledged device is forbidden on GET /targets', async () => {
    h = await harness();
    const d = h.device('macos', 'Unacked');
    await d.pair(h.switchboard.admin.pairingCode());
    const res = await d.request('GET', '/targets');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect((await d.request('GET', '/me')).status).toBe(200);
  });

  test('a used pairing code reused is 401', async () => {
    h = await harness();
    const code = h.switchboard.admin.pairingCode();
    await h.device('macos', 'First').pair(code);
    await expect(h.device('macos', 'Second').pair(code)).rejects.toThrow(/unauthorized/);
    const second = h.device('macos', 'Second');
    const res = await second.request('POST', '/pair', { profile: 'voicestack-app/1', pairing_code: code, device: { installation_id: second.installationId, name: 'Second', platform: 'macos', app_version: '1.0' } }, '');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('(b) validation', () => {
  test('an unknown request field is 400 validation_error', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const a = await mac.request('POST', '/caller-tokens', { operation_id: uuid(), name: 'x', extra: 1 });
    expect(a.status).toBe(400);
    expect(a.body.error.code).toBe('validation_error');
    const b = await place(token.secret, { extra: true });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe('validation_error');
    const c = await mac.request('POST', '/calls', { operation_id: uuid(), direction: 'outgoing', target_id: 'target_main', subject: 'x' });
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('validation_error');
  });

  test('a non-UUID operation_id is 400 validation_error', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const a = await mac.request('POST', '/caller-tokens', { operation_id: 'not-a-uuid', name: 'x' });
    expect(a.status).toBe(400);
    expect(a.body.error.code).toBe('validation_error');
    const b = await place(token.secret, { operation_id: 'not-a-uuid' });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe('validation_error');
    const c = await mac.request('POST', '/calls', { operation_id: 12345, direction: 'outgoing', target_id: 'target_main' });
    expect(c.status).toBe(400);
  });

  test('a subject of 61 characters and a subject of only spaces are 400 validation_error', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const long = await place(token.secret, { subject: 'x'.repeat(61) });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('validation_error');
    const blank = await place(token.secret, { subject: '    ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('validation_error');
    const exact = await place(token.secret, { subject: 'x'.repeat(60) });
    expect(exact.status).toBe(200);
  });

  test('an unknown target_id is 400 validation_error', async () => {
    const { mac } = await setup();
    const res = await mac.request('POST', '/calls', { operation_id: uuid(), direction: 'outgoing', target_id: 'target_nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('(c) idempotency', () => {
  test('POST /caller-tokens replays with the same body and conflicts with a changed body', async () => {
    const { mac } = await setup();
    const operation_id = uuid();
    const first = await mac.request('POST', '/caller-tokens', { operation_id, name: 'Alpha' });
    const again = await mac.request('POST', '/caller-tokens', { operation_id, name: 'Alpha' });
    expect(again.status).toBe(200);
    expect(again.body.token.id).toBe(first.body.token.id);
    const changed = await mac.request('POST', '/caller-tokens', { operation_id, name: 'Beta' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('operation_conflict');
    expect((await mac.request('GET', '/caller-tokens')).body.tokens.length).toBe(1);
  });

  test('POST /calls incoming replays with the same body and conflicts with a changed body', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const operation_id = uuid();
    const first = await place(token.secret, { operation_id });
    expect(first.status).toBe(200);
    const again = await place(token.secret, { operation_id });
    expect(again.status).toBe(200);
    expect(again.body.call.id).toBe(first.body.call.id);
    const changed = await place(token.secret, { operation_id, subject: 'Different' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('operation_conflict');
  });

  test('POST /calls/{id}/accept replays with the same request and conflicts with a changed one', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const first = await place(token.secret);
    const second = await place(token.secret);
    const operation_id = uuid();
    const accepted = await mac.request('POST', `/calls/${first.body.call.id}/accept`, { operation_id });
    expect(accepted.status).toBe(200);
    const replay = await mac.request('POST', `/calls/${first.body.call.id}/accept`, { operation_id });
    expect(replay.status).toBe(200);
    expect(replay.body.call.id).toBe(first.body.call.id);
    // The same operation_id aimed at another call is a changed request.
    const changed = await mac.request('POST', `/calls/${second.body.call.id}/accept`, { operation_id });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('operation_conflict');
  });
});

describe('(d) ring timeout', () => {
  test('an unanswered call ends with no_answer on device events and a later accept is 409 call_not_active', async () => {
    h = await harness({ ringSeconds: 1 });
    const mac = await h.pairedDevice('macos', 'Mac');
    await mac.openEvents();
    const token = await makeToken(mac);
    const placed = await place(token.secret);
    expect(placed.status).toBe(200);
    await mac.waitFor(() => mac.events.some(e => e.type === 'call.incoming'));
    await mac.waitFor(() => mac.events.some(e => e.type === 'call.ended'), 4000);
    expect(mac.events.find(e => e.type === 'call.ended')).toMatchObject({ call_id: placed.body.call.id, reason: 'no_answer' });
    const late = await mac.request('POST', `/calls/${placed.body.call.id}/accept`, { operation_id: uuid() });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('call_not_active');
    mac.closeEvents();
  });
});

describe('(e) readiness', () => {
  test('a cold backend holds admission until ready, without admitting duplicate retries', async () => {
    let release!: (ready: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const readiness = new Promise<boolean>(resolve => { release = resolve; });
    h = await harness({ ready: () => { entered(); return readiness; } });
    const mac = await h.pairedDevice('macos', 'Mac');
    const body = { operation_id: uuid(), direction: 'outgoing', target_id: 'target_main' };
    let finished = false;
    const pending = mac.request('POST', '/calls', body).then(result => { finished = true; return result; });
    await started;
    expect(finished).toBe(false);
    release(true);
    const admitted = await pending;
    expect(admitted.status).toBe(200);
    const retry = await mac.request('POST', '/calls', body);
    expect(retry.body.call.id).toBe(admitted.body.call.id);
  });

  test('backend not ready is 503 backend_unavailable for incoming and outgoing calls', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    h.backendReady.value = false;
    const incoming = await place(token.secret);
    expect(incoming.status).toBe(503);
    expect(incoming.body.error.code).toBe('backend_unavailable');
    expect(incoming.body.error.retryable).toBe(true);
    const outgoing = await mac.request('POST', '/calls', { operation_id: uuid(), direction: 'outgoing', target_id: 'target_main' });
    expect(outgoing.status).toBe(503);
    expect(outgoing.body.error.code).toBe('backend_unavailable');
    h.backendReady.value = true;
    expect((await place(token.secret)).status).toBe(200);
  });

  test('a stopped relay is 503 target_unavailable for calls and GET /targets shows available:false', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    expect((await mac.request('GET', '/targets')).body.targets.find((t: { id: string }) => t.id === 'target_main').available).toBe(true);
    h.relay.stop();
    await mac.waitFor(() => !h.switchboard.connected());
    const incoming = await place(token.secret);
    expect(incoming.status).toBe(503);
    expect(incoming.body.error.code).toBe('target_unavailable');
    const outgoing = await mac.request('POST', '/calls', { operation_id: uuid(), direction: 'outgoing', target_id: 'target_main' });
    expect(outgoing.status).toBe(503);
    expect(outgoing.body.error.code).toBe('target_unavailable');
    const targets = await mac.request('GET', '/targets');
    expect(targets.status).toBe(200);
    expect(targets.body.targets.length).toBeGreaterThan(0);
    expect(targets.body.targets.every((t: { available: boolean }) => t.available === false)).toBe(true);
  });
});

describe('(f) revoked token', () => {
  test('a call placed before revoke keeps ringing and can still be accepted', async () => {
    const { mac } = await setup();
    const token = await makeToken(mac);
    const placed = await place(token.secret);
    expect(placed.status).toBe(200);
    const revoked = await mac.request('POST', `/caller-tokens/${token.id}/revoke`, { operation_id: uuid() });
    expect(revoked.status).toBe(200);
    expect(revoked.body.state).toBe('revoked');
    const view = await mac.request('GET', `/calls/${placed.body.call.id}`);
    expect(view.body.call.state).toBe('ringing');
    const accepted = await mac.request('POST', `/calls/${placed.body.call.id}/accept`, { operation_id: uuid() });
    expect(accepted.status).toBe(200);
    // Accepted calls stay connecting until the owner opens the text channel.
    expect(accepted.body.call).toMatchObject({ state: 'connecting', owner_device_id: mac.deviceId });
    const refused = await place(token.secret);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('token_revoked');
  });
});
