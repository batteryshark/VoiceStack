import { randomUUID, verify, createPublicKey } from 'node:crypto';

export const PROFILE = 'voicestack-mode-a-speech/1';
export const MAX_INPUT = 4096;
export const capabilities = {
  profile: PROFILE,
  transcription: { transport: 'openai-realtime', input: { type: 'audio/pcm', rate: 24000 } },
  speech: { route: '/v1/audio/speech', formats: ['pcm', 'wav'], output: { type: 'audio/pcm', rate: 24000 }, max_input_characters: MAX_INPUT },
  models: ['local-parakeet', 'local-breeze'], voices: ['local-default']
};
export const event = (type, fields = {}) => ({ event_id: `evt_${randomUUID()}`, type, ...fields });
export class Fault extends Error {
  constructor(code, message = code, status = 400, param = null) {
    super(message); Object.assign(this, { code, status, param });
  }
}
export function keys(value, allowed, param = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new Fault('unsupported_feature', 'Unsupported request field', 400, param);
}
export const configuration = () => ({ type: 'transcription', audio: { input: {
  format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null, transcription: { model: 'local-parakeet' }
} } });
export function validateUpdate(s) {
  keys(s, ['type', 'audio'], 'session');
  if (s.type !== 'transcription') throw new Fault('unsupported_feature', 'Transcription session required');
  if (s.audio !== undefined) {
    keys(s.audio, ['input'], 'session.audio');
    if (s.audio.input !== undefined) {
      const input = s.audio.input;
      keys(input, ['format', 'turn_detection', 'transcription'], 'session.audio.input');
      if ('turn_detection' in input && input.turn_detection !== null) throw new Fault('unsupported_feature', 'Server VAD is not supported', 400, 'session.audio.input.turn_detection');
      if (input.format !== undefined) {
        keys(input.format, ['type', 'rate']);
        if (('type' in input.format && input.format.type !== 'audio/pcm') || ('rate' in input.format && input.format.rate !== 24000)) throw new Fault('unsupported_feature', '24 kHz PCM is required');
      }
      if (input.transcription !== undefined) {
        keys(input.transcription, ['model']);
        if ('model' in input.transcription && input.transcription.model !== 'local-parakeet') throw new Fault('unsupported_feature', 'Unsupported transcription model');
      }
    }
  }
  return configuration();
}
export function validateSpeech(body) {
  keys(body, ['model', 'voice', 'input', 'response_format']);
  if (body.model !== 'local-breeze' || body.voice !== 'local-default' || !['pcm', 'wav'].includes(body.response_format)) throw new Fault('unsupported_feature', 'Unsupported speech configuration');
  if (typeof body.input !== 'string' || !body.input.trim() || [...body.input].length > MAX_INPUT) throw new Fault('validation_error', 'Invalid speech input length');
  return body;
}
// Switchboard v0.1.0 sbb1 envelope. Apps continue to treat the credential as opaque.
export function credentialVerifier({ publicKey, audience, clock = () => Date.now() / 1000 }) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !audience) throw new Error('Ed25519 key and audience required');
  return (authorization, expectedCall) => {
    try {
      if (typeof authorization !== 'string' || authorization.length > 16384 || !authorization.startsWith('Bearer ')) throw 0;
      const parts = authorization.slice(7).split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw 0;
      const [version, payload, signature] = parts;
      if (version !== 'sbb1' || !verify(null, Buffer.from(`${version}.${payload}`), key, Buffer.from(signature, 'base64url'))) throw 0;
      const c = JSON.parse(Buffer.from(payload, 'base64url'));
      if (c.v !== 1 || c.aud !== audience || c.profile !== PROFILE || ['call_id', 'binding', 'device_id', 'jti'].some(field => typeof c[field] !== 'string' || !c[field]) || (expectedCall && c.call_id !== expectedCall)) throw 0;
      if (!Number.isInteger(c.exp) || c.exp <= clock() || !Number.isInteger(c.iat) || c.iat > clock() + 5 || c.exp <= c.iat || c.exp - c.iat > 600) throw 0;
      return c;
    } catch { throw new Fault('unauthorized', 'Invalid or expired call credential', 401); }
  };
}
