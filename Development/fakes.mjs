import { generateKeyPairSync, sign } from 'node:crypto';
import { PROFILE } from '../Backend/ModeAAdapter/protocol.mjs';
import { wav } from '../Backend/ModeAAdapter/audio.mjs';

export function testIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const audience = 'voicestack-development';
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), audience,
    issue(callID, changes = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ v: 1, aud: audience, call_id: callID, binding: 'fixture-binding', device_id: 'fixture-device', jti: 'fixture-credential-id', profile: PROFILE, iat: now, exp: now + 120, ...changes })).toString('base64url');
      const body = `sbb1.${payload}`; return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
    }
  };
}
// No Switchboard address, credential or transport can enter this fake.
export function fakeSpeech() {
  const received = { pcm: [], speech: [] };
  return { received, ready: async () => true,
    recognize(done) {
      let cancelled = false; const chunks = [];
      return { append: b => chunks.push(Buffer.from(b)), cancel: () => { cancelled = true; }, commit: () => {
        received.pcm.push(Buffer.concat(chunks)); queueMicrotask(() => { if (!cancelled) done('Use the narrower release boundary.'); });
      } };
    },
    async speech(body) {
      received.speech.push(body.input); const pcm = Buffer.alloc(4800);
      for (let n = 0; n < 2400; n++) pcm.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * n / 24000)), n * 2);
      return body.response_format === 'wav' ? wav(pcm) : pcm;
    }
  };
}
