// The frozen contract (Docs/PROTOCOL.md sections 2 and 3) against the real Switchboard: real HTTP, real
// WebSockets, real SQLite, the real connector relay. Requests are the fixtures verbatim; every response and
// event is checked with Conformance (same keys, same types, same constants, consistent generated ids).
import { afterEach, describe, expect, test } from 'bun:test';
import { harness, uuid, type Harness } from './harness.ts';
import { Conformance, fixture } from './conform.ts';
import { TextChannel } from '../src/stubs/devices.ts';
import { verifyCredential } from '../src/server/backend.ts';

let h: Harness;
afterEach(() => h?.stop());

async function pairBoth(h: Harness, c: Conformance) {
  const iphone = h.device('ios', "Example iPhone", fixture('pair.request').device.installation_id);
  h.switchboard.admin.pairingCode(fixture('pair.request').pairing_code);
  const paired = await iphone.pair('', fixture('pair.request'));
  c.check('pair.response', paired.body);
  const ack = await iphone.ack(fixture('pair-ack.request').operation_id);
  expect(ack.status).toBe(200);
  c.check('pair-ack.response', ack.body);
  const mac = h.device('macos', "Example Mac");
  await mac.pair(h.switchboard.admin.pairingCode());
  await mac.ack();
  c.ids.set('dev_fixture_mac', mac.deviceId);
  return { iphone, mac };
}

describe('section 2: app contract', () => {
  test('2.2 pairing, push registration and availability', async () => {
    h = await harness();
    const c = new Conformance();
    const { iphone, mac } = await pairBoth(h, c);
    const push = await iphone.request('PUT', '/devices/me/push', fixture('push-register.request'));
    expect(push.status).toBe(200);
    const me = await iphone.request('GET', '/me');
    expect(me.body).toMatchObject({ device_id: iphone.deviceId, platform: 'ios', acknowledged: true, push_registered: true, profile: 'voicestack-app/1' });
    expect((await mac.request('PUT', '/devices/me/push', { ...fixture('push-register.request'), operation_id: uuid() })).body.error.code).toBe('forbidden');
    const availability = await iphone.request('PUT', '/devices/me/availability', fixture('availability.request'));
    expect(availability.status).toBe(200);
    // Same id, same body: the recorded result. Same id, changed body: operation_conflict.
    expect((await iphone.request('PUT', '/devices/me/availability', fixture('availability.request'))).status).toBe(200);
    const conflict = await iphone.request('PUT', '/devices/me/availability', { ...fixture('availability.request'), reason: 'quiet_hours' });
    expect(conflict.status).toBe(409);
    c.check('error-envelope', conflict.body, { error: { ...fixture('error-envelope').error, code: 'operation_conflict', message: conflict.body.error.message, operation_id: fixture('availability.request').operation_id } });
    c.ok();
  });

  test('2.3 caller-token lifecycle, 2.5 call request, 2.6 signals, 2.7 accept, taken and end, section 3 text channel', async () => {
    h = await harness();
    const c = new Conformance();
    const { iphone, mac } = await pairBoth(h, c);
    await iphone.registerPush(h.apns, 'fixture-apns-device-token', 'fixture.voicestack', fixture('push-register.request').operation_id);
    c.check('device-ready.event', await mac.openEvents());
    c.check('device-ready.event', await iphone.openEvents(), { ...fixture('device-ready.event'), event_id: 'evt_fixture_ready_iphone' });

    const created = await iphone.request('POST', '/caller-tokens', fixture('caller-token-create.request'));
    expect(created.status).toBe(200);
    c.check('caller-token-create.response', created.body);
    const list = await mac.request('GET', '/caller-tokens');
    c.check('caller-token-list.response', list.body);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    const secret = created.body.secret as string;

    // 7.1 error envelope: the contract's own example.
    const bad = await fetch(`${h.appBase}/calls`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: fixture('error-envelope').error.operation_id, direction: 'incoming', subject: 'x'.repeat(61) }) });
    expect(bad.status).toBe(400);
    c.check('error-envelope', await bad.json());

    // 7.5: the caller token places the call.
    const placed = await fetch(`${h.appBase}/calls`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(fixture('incoming-call.request')) });
    expect(placed.status).toBe(200);
    const incoming = await placed.json();
    c.check('incoming-call.response', incoming);

    // 7.6: Mac over device events, iPhone over the APNs stub; both carry the same display fields.
    await mac.waitFor(() => mac.events.some(e => e.type === 'call.incoming'));
    c.check('call-incoming.event', mac.events.find(e => e.type === 'call.incoming'));
    await iphone.waitFor(() => iphone.rings.some(r => r.via === 'apns'));
    const apns = h.apns.received.at(-1)!;
    c.check('incoming-apns.payload', apns.payload);
    expect(apns.headers['apns-push-type']).toBe('voip');
    expect(apns.headers['apns-topic']).toBe('fixture.voicestack.voip');
    expect(iphone.rings.find(r => r.via === 'apns')!.reconciled).toMatchObject({ call: { id: incoming.call.id, state: 'ringing', caller_name: 'Agent' } });

    // 7.7: Mac accepts first; the iPhone gets call_taken and the call.taken event.
    const accepted = await mac.request('POST', `/calls/${incoming.call.id}/accept`, fixture('accept.request'));
    expect(accepted.status).toBe(200);
    c.check('accept.response', accepted.body);
    const claims = verifyCredential(accepted.body.backend.credential, h.switchboard.signer.publicKey, { aud: 'voice-mac', profile: 'voicestack-mode-a-speech/1', call_id: incoming.call.id, nowMs: Date.now() });
    expect(claims.binding).toBe(accepted.body.call.target_binding);
    const late = await iphone.request('POST', `/calls/${incoming.call.id}/accept`, { operation_id: uuid() });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('call_taken');
    await iphone.waitFor(() => iphone.events.some(e => e.type === 'call.taken'));
    c.check('call-taken.event', iphone.events.find(e => e.type === 'call.taken'));
    expect(mac.events.some(e => e.type === 'call.taken')).toBe(false);

    // Section 3: the owning app's text channel through the real relay into the (scripted) lane.
    const channel = await TextChannel.connect(h.switchboard.url, accepted.body.call.text_channel, mac.credential);
    await channel.waitFor(f => f.length >= 1);
    c.check('text-call-ready.event', channel.frames[0]);
    channel.send(fixture('text-turn-submit.client'));
    await channel.waitFor(f => f.some(x => x.type === 'reply.done'));
    const [ready, acceptedTurn, delta1, delta2, done] = channel.frames;
    expect(ready.type).toBe('call.ready');
    c.check('text-turn-accepted.event', acceptedTurn);
    c.check('text-reply-delta-1.event', delta1);
    c.check('text-reply-delta-2.event', delta2);
    c.check('text-reply-done.event', done);
    expect(h.lane.delivered.map(d => d.turn.text)).toEqual(['Use the narrower release boundary.']);
    expect(h.lane.delivered[0].turn.delivery).toBe('queue');

    // A duplicate submit returns the recorded status and is not delivered again; a changed one conflicts.
    channel.send(fixture('text-turn-submit.client'));
    await channel.waitFor(f => f.filter(x => x.type === 'turn.accepted').length === 2 && f.filter(x => x.type === 'reply.done').length === 2);
    expect(h.lane.delivered.length).toBe(1);
    c.check('text-turn-accepted.event', channel.frames.filter(x => x.type === 'turn.accepted')[1]);
    c.check('text-reply-done.event', channel.frames.filter(x => x.type === 'reply.done')[1]);
    channel.send({ ...fixture('text-turn-submit.client'), text: 'Something else.' });
    await channel.waitFor(f => f.some(x => x.type === 'error'));
    expect((channel.frames.find(x => x.type === 'error') as any).error.code).toBe('operation_conflict');
    expect(h.lane.delivered.length).toBe(1);

    // End: every device and the text channel get call.ended.
    const ended = await mac.request('POST', `/calls/${incoming.call.id}/end`, fixture('end.request'));
    expect(ended.status).toBe(200);
    await channel.waitFor(f => f.some(x => x.type === 'call.ended'));
    c.check('call-ended.event', channel.frames.find(x => x.type === 'call.ended'));
    await iphone.waitFor(() => iphone.events.some(e => e.type === 'call.ended'));
    c.check('call-ended.event', iphone.events.find(e => e.type === 'call.ended'));

    // Revoke, then the token's next call is refused; delete only after revoke.
    expect((await iphone.request('DELETE', `/caller-tokens/${created.body.token.id}`, { operation_id: uuid() })).body.error.code).toBe('token_active');
    const revoked = await iphone.request('POST', `/caller-tokens/${created.body.token.id}/revoke`, fixture('caller-token-revoke.request'));
    c.check('caller-token-revoke.response', revoked.body);
    const refused = await fetch(`${h.appBase}/calls`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture('incoming-call.request'), operation_id: uuid() }) });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('token_revoked');
    const deleted = await iphone.request('DELETE', `/caller-tokens/${created.body.token.id}`, { operation_id: uuid() });
    expect(deleted.status).toBe(204);
    expect((await iphone.request('GET', '/caller-tokens')).body).toEqual({ tokens: [] });
    c.ok();
  });

  test('2.4 targets and outgoing dial-in; the binding holds when the pointer moves', async () => {
    h = await harness();
    const c = new Conformance();
    const { iphone } = await pairBoth(h, c);
    c.check('targets.response', (await iphone.request('GET', '/targets')).body);
    const outgoing = await iphone.request('POST', '/calls', fixture('outgoing-call.request'));
    expect(outgoing.status).toBe(200);
    c.check('outgoing-call.response', outgoing.body);
    const pinned = h.lane.delivered.length;
    h.lane.pointer.target_main = 'conversation-2';
    const channel = await TextChannel.connect(h.switchboard.url, outgoing.body.call.text_channel, iphone.credential);
    channel.send({ type: 'turn.submit', operation_id: uuid(), text: 'Hello.', delivery: 'queue' });
    await channel.waitFor(f => f.some(x => x.type === 'reply.done'));
    expect(h.lane.delivered.length).toBe(pinned + 1);
    expect(JSON.parse(h.lane.delivered.at(-1)!.laneRef).conversation).toBe('conversation-1');
    const ready = channel.frames[0] as any;
    expect(ready.target_binding).toBe(outgoing.body.call.target_binding);
    // A repeat of the same request is the same call, with a fresh short-lived credential.
    const repeat = await iphone.request('POST', '/calls', fixture('outgoing-call.request'));
    expect(repeat.body.call.id).toBe(outgoing.body.call.id);
    c.check('outgoing-call.response', repeat.body);
    channel.close();
    c.ok();
  });

  test('2.7 decline under phone focus ends the ring on both devices', async () => {
    h = await harness();
    const c = new Conformance();
    const { iphone, mac } = await pairBoth(h, c);
    await iphone.registerPush(h.apns, 'fixture-apns-device-token');
    await mac.openEvents();
    const created = await iphone.request('POST', '/caller-tokens', { operation_id: uuid(), name: 'Agent' });
    const placed = await fetch(`${h.appBase}/calls`, { method: 'POST', headers: { authorization: `Bearer ${created.body.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(fixture('incoming-call.request')) });
    const call = (await placed.json()).call;
    await iphone.waitFor(() => iphone.rings.length > 0);
    c.ids.set('call_fixture_incoming', call.id);
    const declined = await iphone.request('POST', `/calls/${call.id}/decline`, fixture('decline.request'));
    expect(declined.status).toBe(200);
    expect(declined.body.call.state).toBe('ended');
    await mac.waitFor(() => mac.events.some(e => e.type === 'call.ended'));
    c.check('call-ended.event', mac.events.find(e => e.type === 'call.ended'), { ...fixture('call-ended.event'), reason: 'focus' });
    expect((await mac.request('POST', `/calls/${call.id}/accept`, { operation_id: uuid() })).body.error.code).toBe('call_not_active');
    c.ok();
  });

  test('2.7 backend handoff: a fresh handout only for the active owner', async () => {
    h = await harness();
    const c = new Conformance();
    const { iphone, mac } = await pairBoth(h, c);
    const outgoing = await iphone.request('POST', '/calls', fixture('outgoing-call.request'));
    const handoff = await iphone.request('POST', `/calls/${outgoing.body.call.id}/backend-handoff`, { operation_id: uuid() });
    expect(handoff.status).toBe(200);
    c.ids.set('call_fixture_outgoing', outgoing.body.call.id);
    c.check('backend-handoff', handoff.body, { backend: fixture('outgoing-call.response').backend });
    expect(handoff.body.backend.credential).not.toBe(outgoing.body.backend.credential);
    expect((await mac.request('POST', `/calls/${outgoing.body.call.id}/backend-handoff`, { operation_id: uuid() })).body.error.code).toBe('forbidden');
    c.ok();
  });
});
