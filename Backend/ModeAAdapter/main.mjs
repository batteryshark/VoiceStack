import { readFileSync } from 'node:fs';
import { credentialVerifier } from './protocol.mjs';
import { createAdapter, localUpstreams } from './server.mjs';
import { speechSettings, managementVerifier } from './settings.mjs';

// File paths, never credentials in command-line arguments. No Switchboard URL exists here.
try {
  const env = process.env;
  if (!env.VOICE_TLS_CERT || !env.VOICE_TLS_KEY || !env.VOICE_VERIFY_KEY || !env.VOICE_AUDIENCE || !env.VOICE_BIND) throw new Error('configuration');
  const octets = env.VOICE_BIND.split('.').map(Number);
  const tailnet = octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!tailnet && !['127.0.0.1', '::1'].includes(env.VOICE_BIND) && !env.VOICE_BIND.startsWith('fd7a:115c:a1e0:')) throw new Error('explicit tailnet or loopback bind required');
  const publicKey = readFileSync(env.VOICE_VERIFY_KEY);
  const settings = env.VOICE_SETTINGS_FILE ? await speechSettings({ file: env.VOICE_SETTINGS_FILE, initialVoice: env.VOICE_BREEZE_VOICE ?? 'default' }) : undefined;
  const adapter = createAdapter({
    tls: { cert: readFileSync(env.VOICE_TLS_CERT), key: readFileSync(env.VOICE_TLS_KEY), minVersion: 'TLSv1.2' },
    verifyCredential: credentialVerifier({ publicKey: readFileSync(env.VOICE_VERIFY_KEY), audience: env.VOICE_AUDIENCE }),
    settings, verifyManagement: managementVerifier({ publicKey, audience: env.VOICE_AUDIENCE }),
    upstreams: localUpstreams({ voice: settings?.voice ?? env.VOICE_BREEZE_VOICE ?? 'default' })
  });
  adapter.server.listen(Number(env.VOICE_PORT ?? 8448), env.VOICE_BIND, () => console.log('VoiceStack speech adapter listening; readiness available at /health'));
  adapter.server.on('error', () => { console.error('Adapter listener failed'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await adapter.close(); process.exit(0); });
} catch { console.error('Adapter configuration invalid. Supply TLS, verification key, audience and explicit private bind.'); process.exitCode = 1; }
