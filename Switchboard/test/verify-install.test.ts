// scripts/verify-install.ts against a local Switchboard with a scripted lane, so the run against an installed
// instance has been exercised end to end before it matters.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.stop());

test('verify-install passes every check against a working instance and consumes its pairing code', async () => {
  h = await harness({ replies: () => ['Received. ', 'This is the agent.'] });
  const keyFile = join(h.dir, 'key.pem');
  writeFileSync(keyFile, h.switchboard.signer.publicPem());
  const codeFile = join(h.dir, 'code');
  writeFileSync(codeFile, h.switchboard.admin.pairingCode(), { mode: 0o600 });
  const out = join(h.dir, 'results');
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/verify-install.ts'), '--base', h.appBase, '--loopback', h.switchboard.url, '--code-file', codeFile, '--key', keyFile, '--out', out], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const checks = JSON.parse(readFileSync(join(out, 'checks.json'), 'utf8')) as { check: string; ok: boolean }[];
  expect(checks.filter(c => !c.ok)).toEqual([]);
  expect(exit).toBe(0);
  expect(checks.map(c => c.check)).toContain('lane reply over the text channel');
  expect(existsSync(codeFile)).toBe(false);
  expect(existsSync(join(out, '.caller-token'))).toBe(false);
  expect(h.lane.delivered[0].turn.text).toContain('Switchboard install check');
  expect(stdout + stderr).not.toMatch(/sbc_|sbd_/);
});

test('verify-install fails closed when the published key is not the instance key', async () => {
  h = await harness();
  const { generateKeyPairSync } = await import('node:crypto');
  const keyFile = join(h.dir, 'wrong.pem');
  writeFileSync(keyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string);
  const codeFile = join(h.dir, 'code');
  writeFileSync(codeFile, h.switchboard.admin.pairingCode(), { mode: 0o600 });
  const out = join(h.dir, 'results');
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/verify-install.ts'), '--base', h.appBase, '--loopback', h.switchboard.url, '--code-file', codeFile, '--key', keyFile, '--out', out], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(1);
  const checks = JSON.parse(readFileSync(join(out, 'checks.json'), 'utf8')) as { check: string; ok: boolean; detail: string }[];
  expect(checks.at(-1)).toMatchObject({ check: 'run', ok: false });
  expect(checks.at(-1)!.detail).toContain('bad signature');
});
