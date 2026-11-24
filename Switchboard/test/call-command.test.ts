// The connector's real call command, run as its own process the way an agent's shell runs it:
// the call rings a stub iPhone through the APNs stub (and an open stub Mac over device events) with the contract's
// incoming-call signal; the token store holds hashes only; after revoke the next call is refused.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { harness, uuid, type Harness } from './harness.ts';
import { Conformance, fixture } from './conform.ts';

let h: Harness;
afterEach(() => h?.stop());

const CLI = join(import.meta.dir, '..', 'src/connector/cli.ts');

async function callCommand(configPath: string, subject: string, operationId?: string) {
  const proc = Bun.spawn([process.execPath, CLI, 'call', '--subject', subject, '--config', configPath, ...(operationId ? ['--operation-id', operationId] : [])], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exit, stdout, stderr, body: JSON.parse(stdout) };
}

async function setup() {
  h = await harness();
  const iphone = await h.pairedDevice('ios', "Example iPhone");
  await iphone.registerPush(h.apns, 'stub-voip-token-1', 'fixture.voicestack');
  const mac = await h.pairedDevice('macos', "Example Mac");
  await mac.openEvents();
  const created = await iphone.request('POST', '/caller-tokens', { operation_id: uuid(), name: 'Agent' });
  // The user stores the token where the call tool reads it: a file only its user can read.
  const tokenPath = join(h.dir, 'caller-token');
  writeFileSync(tokenPath, created.body.secret + '\n', { mode: 0o600 });
  const configPath = join(h.dir, 'connector.json');
  writeFileSync(configPath, JSON.stringify({ switchboard: h.switchboard.url, caller_token: { file: tokenPath } }));
  return { iphone, mac, created, tokenPath, configPath };
}

test('the call command rings the stub iPhone through the APNs stub with the contract signal', async () => {
  const { iphone, mac, created, configPath } = await setup();
  const result = await callCommand(configPath, 'Need to settle the release boundary');
  expect(result.exit).toBe(0);
  expect(result.stdout).not.toContain(created.body.secret);
  const c = new Conformance();
  c.check('incoming-call.response', { call: result.body.call });
  await iphone.waitFor(() => iphone.rings.length === 1 && mac.rings.length === 1);
  const push = h.apns.received[0];
  c.check('incoming-apns.payload', push.payload);
  expect(push.token).toBe('stub-voip-token-1');
  expect(push.headers).toMatchObject({ 'apns-push-type': 'voip', 'apns-topic': 'fixture.voicestack.voip', 'apns-priority': '10' });
  expect(Number(push.headers['apns-expiration'])).toBe(Date.parse(result.body.call.ring_expires_at) / 1000);
  // The stub iPhone reports the call (caller name, then subject) and reconciles with GET /calls/{id}.
  expect(iphone.rings[0]).toMatchObject({ via: 'apns', call_id: result.body.call.id, caller_name: 'Agent', subject: 'Need to settle the release boundary' });
  expect(iphone.rings[0].reconciled).toMatchObject({ call: { id: result.body.call.id, state: 'ringing' } });
  c.check('call-incoming.event', mac.events.find(e => e.type === 'call.incoming'));
  // The call record names the routes that rang: the iPhone through APNs, the open Mac through device events.
  const signals = h.switchboard.store.signals(result.body.call.id);
  expect(signals.map(s => [s.device_id, s.route])).toEqual(expect.arrayContaining([[iphone.deviceId, 'apns_stub'], [mac.deviceId, 'device_events']]));
  expect(signals).toHaveLength(2);
  c.ok();
});

test('hashes only, and a revoked token\'s next call is refused', async () => {
  const { iphone, created, configPath } = await setup();
  const first = await callCommand(configPath, 'First call');
  expect(first.exit).toBe(0);
  const revoke = await iphone.request('POST', `/caller-tokens/${created.body.token.id}/revoke`, { operation_id: uuid() });
  expect(revoke.body.state).toBe('revoked');
  const refused = await callCommand(configPath, 'Second call');
  expect(refused.exit).toBe(2);
  expect(refused.body).toMatchObject({ refused: true, status: 403, error: { code: 'token_revoked' } });
  expect(h.apns.received.length).toBe(1);
  // The placed call goes through: still ringing after revoke.
  expect(h.switchboard.store.call(first.body.call.id)!.state).toBe('ringing');
  const requests = h.switchboard.store.callRequests();
  expect(requests[0]).toMatchObject({ caller_token_id: created.body.token.id, result: 'token_revoked', call_id: null });

  // No secret is stored anywhere in the database files, only sha256 hashes.
  const secrets = [created.body.secret, iphone.credential];
  h.switchboard.store.db.exec('PRAGMA wal_checkpoint(FULL)');
  for (const file of readdirSync(h.dir).filter(f => f.startsWith('switchboard.sqlite'))) {
    const bytes = readFileSync(join(h.dir, file)).toString('latin1');
    for (const secret of secrets) expect(bytes.includes(secret)).toBe(false);
  }
  const row = h.switchboard.store.db.query('SELECT secret_hash FROM caller_token WHERE id = ?').get(created.body.token.id) as { secret_hash: string };
  expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.secret_hash).toBe(new Bun.CryptoHasher('sha256').update(created.body.secret).digest('hex'));
  const columns = h.switchboard.store.db.query("SELECT name FROM pragma_table_info('caller_token')").all().map((r: any) => r.name);
  expect(columns).not.toContain('secret');
});

test('the call command reconciles an uncertain call with the same operation id and never prints the token', async () => {
  const { configPath, created } = await setup();
  const operationId = uuid();
  const first = await callCommand(configPath, 'Same call', operationId);
  const again = await callCommand(configPath, 'Same call', operationId);
  expect(again.exit).toBe(0);
  expect(again.body.call.id).toBe(first.body.call.id);
  expect(h.apns.received.length).toBe(1);
  const changed = await callCommand(configPath, 'Different subject', operationId);
  expect(changed.body.error.code).toBe('operation_conflict');
  for (const out of [first, again, changed]) expect(out.stdout + out.stderr).not.toContain(created.body.secret);
});

test('the call command refuses a token file others can read', async () => {
  const { configPath, tokenPath } = await setup();
  const { chmodSync } = await import('node:fs');
  chmodSync(tokenPath, 0o644);
  const result = await callCommand(configPath, 'Exposed token');
  expect(result.exit).toBe(2);
  expect(result.body.error.message).toContain('must not be accessible to others');
  expect(h.apns.received.length).toBe(0);
  expect(fixture('incoming-call.request').direction).toBe('incoming');
});
