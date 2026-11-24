#!/usr/bin/env bun
// Verifies an installed Switchboard end to end, then relays one text exchange through its connector:
//   bun scripts/verify-install.ts --base https://HOST:PORT/voicestack/v1 --code-file FILE --key PUBLIC-KEY.pem
//       [--loopback http://127.0.0.1:47860] [--out DIR] [--text TEXT]
// --code-file holds one unused pairing code (`switchboard pairing-code`); --key is `switchboard backend key`.
// A stub Mac speaks voicestack-app/1 over the public route as the app does. The call is placed with the
// connector's real call command over loopback, as an agent would. The installed relay carries the turn into the
// default target, so this SENDS ONE REAL MESSAGE to whatever conversation that target is. The published key
// must verify the handout credential this instance signs.
import { createPublicKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StubDevice, TextChannel } from '../src/stubs/devices.ts';
import { verifyCredential } from '../src/server/backend.ts';
import { call } from '../src/connector/cli.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); const value = i >= 0 ? argv[i + 1] : fallback; if (value === undefined) { console.error(`--${name} is required`); process.exit(64); } return value; };
const root = resolve(import.meta.dir, '..');
const base = flag('base');
const loopback = flag('loopback', 'http://127.0.0.1:47860');
const codeFile = flag('code-file');
const keyFile = flag('key');
const out = resolve(flag('out', join(root, 'var', `verify-install-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`)));
const text = flag('text', 'This is a Switchboard install check. Please reply with one short sentence confirming you received this voice-call turn.');

const checks: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => { checks.push({ check, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${check}: ${detail}`); if (!ok) throw new Error(`${check}: ${detail}`); };
mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');

let channel: TextChannel | null = null;
let mac: StubDevice | null = null;
try {
  const origin = new URL(base).origin;
  const health = await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })).json() as { status?: string };
  record('health', health.status === 'ok', `${origin}/health → ${JSON.stringify(health)}`);
  const key = createPublicKey(readFileSync(keyFile));
  record('published key', key.asymmetricKeyType === 'ed25519', `${keyFile} is ${key.asymmetricKeyType}`);

  mac = new StubDevice(base, 'macos', 'verifier Mac');
  const code = readFileSync(codeFile, 'utf8').trim();
  await mac.pair(code); await mac.ack();
  try { unlinkSync(codeFile); } catch { /* the code is used up either way */ }
  record('pairing code issued and accepted', !!mac.deviceId, `paired ${mac.deviceId} over the public route`);
  await mac.openEvents();
  const targets = await mac.request('GET', '/targets');
  record('relay connected', targets.body.targets.some((t: { id: string; available: boolean }) => t.id === 'target_main' && t.available), JSON.stringify(targets.body.targets));

  const created = await mac.request('POST', '/caller-tokens', { operation_id: crypto.randomUUID(), name: 'Agent' });
  const tokenPath = join(out, '.caller-token');
  writeFileSync(tokenPath, created.body.secret, { mode: 0o600 }); chmodSync(tokenPath, 0o600);
  let printed = '';
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string) => { printed += chunk; return true; };
  let exit: number;
  try { exit = await call({ switchboard: loopback, caller_token: { file: tokenPath } }, 'Install check of the Switchboard text relay'); }
  finally { (process.stdout as { write: unknown }).write = original; }
  write('call-command.json', printed);
  const placed = JSON.parse(printed);
  record('call command rang', exit === 0 && placed.call?.state === 'ringing', `exit ${exit}: ${printed.replace(/\s+/g, ' ').slice(0, 200)}`);
  await mac.waitFor(() => mac!.rings.some(r => r.call_id === placed.call.id), 5000);
  record('incoming signal on device events', true, `call.incoming for ${placed.call.id}`);

  const accepted = await mac.request('POST', `/calls/${placed.call.id}/accept`, { operation_id: crypto.randomUUID() });
  record('accepted', accepted.status === 200, `owner ${accepted.body.call?.owner_device_id}`);
  const claims = verifyCredential(accepted.body.backend.credential, key, { aud: accepted.body.backend.credential ? JSON.parse(Buffer.from(accepted.body.backend.credential.split('.')[1], 'base64url').toString()).aud : '', profile: 'voicestack-mode-a-speech/1', call_id: placed.call.id, nowMs: Date.now() });
  record('handout verifies with the published key', claims.call_id === placed.call.id, `aud ${claims.aud}, exp ${new Date(claims.exp * 1000).toISOString()}`);

  channel = await TextChannel.connect(origin, accepted.body.call.text_channel, mac.credential);
  await channel.waitFor(f => f.some(x => x.type === 'call.ready'));
  const submit = { type: 'turn.submit', operation_id: crypto.randomUUID(), text, delivery: 'steer' };
  channel.send(submit);
  await channel.waitFor(f => f.some(x => x.type === 'reply.done' || x.type === 'error'), 630_000);
  const done = channel.frames.find(x => x.type === 'reply.done') as { status?: string; text?: string } | undefined;
  write('text-channel.jsonl', [{ direction: 'app→switchboard', ...submit }, ...channel.frames.map(f => ({ direction: 'switchboard→app', ...f }))].map(f => JSON.stringify(f)).join('\n') + '\n');
  record('lane reply over the text channel', done?.status === 'completed' && !!done.text, JSON.stringify(done?.text ?? channel.frames.at(-1)).slice(0, 200));
  const ended = await mac.request('POST', `/calls/${placed.call.id}/end`, { operation_id: crypto.randomUUID(), reason: 'user' });
  write('call-view.json', (await mac.request('GET', `/calls/${placed.call.id}`)).body);
  record('ended', ended.status === 200, `call ${placed.call.id}`);
  const revoked = await mac.request('POST', `/caller-tokens/${created.body.token.id}/revoke`, { operation_id: crypto.randomUUID() });
  record('verifier token revoked', revoked.body.state === 'revoked', created.body.token.id);
} catch (error) {
  checks.push({ check: 'run', ok: false, detail: String(error).slice(0, 300) });
} finally {
  channel?.close(); mac?.closeEvents();
  try { unlinkSync(join(out, '.caller-token')); } catch { /* not created */ }
  write('checks.json', checks);
  console.log(`results: ${out}`);
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}
