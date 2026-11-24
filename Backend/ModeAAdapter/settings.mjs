import { readFile, writeFile, rename } from 'node:fs/promises';
import { verify, createPublicKey, randomUUID } from 'node:crypto';
import { Fault } from './protocol.mjs';

// Management credentials never enter an app or a call. Switchboard signs them
// for a specific HTTP action; ordinary sbb1 call credentials cannot configure speech.
export function managementVerifier({ publicKey, audience, clock = () => Date.now() / 1000 }) {
  const key = createPublicKey(publicKey);
  return (authorization, method, path) => {
    try {
      if (typeof authorization !== 'string' || authorization.length > 4096 || !authorization.startsWith('Bearer ')) throw 0;
      const [version, payload, signature, extra] = authorization.slice(7).split('.');
      if (version !== 'sba1' || extra || !payload || !signature || !verify(null, Buffer.from(`${version}.${payload}`), key, Buffer.from(signature, 'base64url'))) throw 0;
      const c = JSON.parse(Buffer.from(payload, 'base64url'));
      if (c.v !== 1 || c.aud !== audience || c.scope !== 'speech.settings' || c.method !== method || c.path !== path || typeof c.jti !== 'string') throw 0;
      if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.iat > clock() + 5 || c.exp <= clock() || c.exp <= c.iat || c.exp - c.iat > 60) throw 0;
    } catch { throw new Fault('unauthorized', 'Speech management credential required', 401); }
  };
}

export async function speechSettings({ file, initialVoice = 'default', catalog = async () => {
  const response = await fetch('http://127.0.0.1:8444/v1/voices', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Fault('backend_unavailable', 'Voice catalog unavailable', 503);
  return response.json();
} }) {
  let selected = initialVoice, operations = {}, writing = Promise.resolve();
  try { const data = JSON.parse(await readFile(file, 'utf8')); if (typeof data.voice !== 'string') throw new Error('invalid settings'); selected = data.voice; operations = data.operations ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const choices = async () => {
    const source = await catalog();
    if (!Array.isArray(source.voices) || source.voices.length > 200) throw new Fault('backend_unavailable', 'Invalid voice catalog', 503);
    const voices = source.voices.map(v => {
      if (typeof v.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.name) || typeof v.label !== 'string' || v.label.length > 120) throw new Fault('backend_unavailable', 'Invalid voice catalog', 503);
      return { id: v.name, label: v.label };
    });
    const defaultVoice = voices.find(v => v.id === source.default);
    return { voices: [{ id: 'default', label: `Server default${defaultVoice ? ` (${defaultVoice.label})` : ''}` }, ...voices], default_voice: source.default };
  };
  const validate = async voice => {
    const data = await choices();
    if (!data.voices.some(v => v.id === voice)) throw new Fault('validation_error', 'Choose an available voice');
    return data;
  };
  return {
    voice: () => selected,
    snapshot: async () => ({ ...(await choices()), voice: selected }),
    validate,
    set: (voice, operationId) => {
      const result = writing.catch(() => {}).then(async () => {
        if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) throw new Fault('validation_error', 'Operation identifier required');
        const data = await validate(voice);
        if (Object.hasOwn(operations, operationId)) {
          if (operations[operationId] !== voice) throw new Fault('operation_conflict', 'Operation already used', 409);
          return { ...data, voice };
        }
        const next = { ...operations, [operationId]: voice };
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ voice, operations: next }) + '\n', { mode: 0o600 });
        await rename(temporary, file); selected = voice; operations = next;
        return { ...data, voice: selected };
      });
      writing = result; return result;
    }
  };
}
