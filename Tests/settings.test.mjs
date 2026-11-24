import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speechSettings, managementVerifier } from '../Backend/ModeAAdapter/settings.mjs';
import { createAdapter } from '../Backend/ModeAAdapter/server.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const credential = (method, path, extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const body = 'sba1.' + Buffer.from(JSON.stringify({ v: 1, aud: 'voice-test', scope: 'speech.settings', method, path, iat: now, exp: now + 60, jti: randomUUID(), ...extra })).toString('base64url');
  return 'Bearer ' + body + '.' + sign(null, Buffer.from(body), keys.privateKey).toString('base64url');
};
const catalog = async () => ({ default: 'ash', voices: [{ name: 'ash', label: 'Ash', reference_text: 'not exposed' }, { name: 'birch', label: 'Birch' }] });

test('management credentials are separate, scoped to a method/path, and short lived', () => {
  const verify = managementVerifier({ publicKey, audience: 'voice-test' });
  const valid = credential('GET', '/admin/speech');
  assert.doesNotThrow(() => verify(valid, 'GET', '/admin/speech'));
  for (const auth of ['Bearer sbb1.any.call', credential('PUT', '/admin/speech'), credential('GET', '/admin/speech', { aud: 'other' }), credential('GET', '/admin/speech', { exp: 1 }), credential('GET', '/admin/speech', { scope: 'other' })]) {
    assert.throws(() => verify(auth, 'GET', '/admin/speech'), { code: 'unauthorized' });
  }
});

test('shared voice persists and a lost-response retry cannot undo a later selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-settings-'));
  try {
    const file = join(dir, 'settings.json'); let settings = await speechSettings({ file, catalog });
    const first = randomUUID(), second = randomUUID();
    await settings.set('birch', first); await settings.set('ash', second);
    settings = await speechSettings({ file, catalog });
    await settings.set('birch', first);
    assert.equal(settings.voice(), 'ash');
    await assert.rejects(settings.set('ash', first), { code: 'operation_conflict' });
    await assert.rejects(settings.set('../unknown', randomUUID()), { code: 'validation_error' });
    assert.equal(settings.voice(), 'ash');
    assert.ok(!JSON.stringify(await settings.snapshot()).includes('reference_text'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('adapter management requires its own authorization and previews without changing the shared voice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-admin-'));
  const settings = await speechSettings({ file: join(dir, 'settings.json'), catalog });
  const previews = [];
  const adapter = createAdapter({ development: true, settings, verifyManagement: managementVerifier({ publicKey, audience: 'voice-test' }), verifyCredential: () => { throw new Error('no call credential'); }, upstreams: { speech: async (_, voice) => { previews.push(voice); return Buffer.alloc(960); } } });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${adapter.server.address().port}`;
  const request = (method, path, body, auth = credential(method, path)) => fetch(base + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await request('GET', '/admin/speech', undefined, 'Bearer sbb1.call')).status, 401);
    assert.equal((await request('PUT', '/admin/speech', { voice: 'birch', operation_id: randomUUID() })).status, 200);
    const preview = await request('POST', '/admin/speech/preview', { voice: 'ash' });
    assert.equal(preview.status, 200); assert.equal((await preview.arrayBuffer()).byteLength, 960);
    assert.deepEqual(previews, ['ash']); assert.equal(settings.voice(), 'birch');
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});
