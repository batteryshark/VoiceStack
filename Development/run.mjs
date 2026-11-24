import { readFileSync } from 'node:fs';
import { testIdentity, fakeSpeech } from './fakes.mjs';
import { createSwitchboard } from './switchboard.mjs';
import { createAdapter } from '../Backend/ModeAAdapter/server.mjs';
import { credentialVerifier } from '../Backend/ModeAAdapter/protocol.mjs';

// Explicit local development only. TLS certificates must be trusted by the device.
const tls = process.env.VOICE_DEV_CERT && process.env.VOICE_DEV_KEY ? { cert: readFileSync(process.env.VOICE_DEV_CERT), key: readFileSync(process.env.VOICE_DEV_KEY) } : undefined;
const scheme = tls ? 'https' : 'http', identity = testIdentity();
const host = process.env.VOICE_DEV_HOST ?? '127.0.0.1';
const bind = process.env.VOICE_DEV_BIND ?? '127.0.0.1';
if (!tls && bind !== '127.0.0.1') throw new Error('Non-loopback development binds require TLS');
const fake = fakeSpeech();
const speech = createAdapter({ tls, development: !tls, verifyCredential: credentialVerifier(identity), upstreams: fake });
const board = createSwitchboard({ tls, issueCredential: id => identity.issue(id), speechOrigin: `${scheme}://${host}:8848` });
board.setOrigin(`${scheme}://${host}:8847`);
speech.server.listen(8848, bind); board.server.listen(8847, bind);
console.log(`Development Switchboard: ${scheme}://${host}:8847/voicestack/v1`);
console.log('Fixture pairing codes: fixture-one-use-code-mac / fixture-one-use-code-ios');
console.log('Native apps require trusted HTTPS. HTTP mode is for automated tests only.');
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await Promise.all([speech.close(), board.close()]); process.exit(0); });
