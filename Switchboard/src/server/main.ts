#!/usr/bin/env bun
// switchboard: the server and its administration, all against one config file.
//   switchboard serve                          run the server
//   switchboard pairing-code                   print one one-use pairing code for an app
//   switchboard connector-credential NAME      print a connector credential once (store it with chmod 600)
//   switchboard backend list | use ID | key    backends, the active one, the credential verification key
//   switchboard calls [--limit N]              call records (no credentials, no audio, no words)
//   switchboard requests | devices | tokens    caller-token requests, paired devices, caller tokens (no secrets)
//   switchboard device-revoke DEVICE_ID        retire a device credential
// Every command takes --config FILE (default $SWITCHBOARD_CONFIG or ./switchboard.json).
import { loadConfig } from './config.ts';
import { startSwitchboard } from './app.ts';
import { Store } from './store.ts';
import { Profiles } from './profiles.ts';
import { Signer } from './backend.ts';
import { newId, newPairingCode, newSecret, rfc3339 } from '../common/util.ts';

function flag(argv: string[], name: string) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const argv = process.argv.slice(2);
  const [command, sub] = argv;
  const config = loadConfig(flag(argv, 'config') ?? process.env.SWITCHBOARD_CONFIG ?? 'switchboard.json');
  const at = rfc3339(Date.now());
  if (command === 'serve') {
    const switchboard = startSwitchboard({ config });
    const stop = () => { switchboard.stop(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    return;
  }
  const store = new Store(config.database);
  try {
    switch (command) {
      case 'pairing-code': { const code = newPairingCode(); store.addPairingCode(code, at); print({ pairing_code: code, note: 'one use; type it into the app, never into a link or log' }); break; }
      case 'connector-credential': {
        if (!sub || sub.startsWith('--')) throw new Error('usage: switchboard connector-credential NAME');
        const id = newId('conn'); const secret = newSecret('sbk');
        store.addConnectorCredential(id, sub, secret, at);
        print({ id, name: sub, credential: secret, note: 'shown once; store it in a file only the connector user can read (chmod 600)' });
        break;
      }
      case 'connector-revoke': { print({ revoked: store.revokeConnector(sub, at) }); break; }
      case 'admin-password': {
        const password = (await Bun.stdin.text()).trim();
        if (password.length < 8) throw new Error('Provide a password of at least 8 characters on stdin');
        store.setSetting('admin_password_hash', await Bun.password.hash(password));
        print({ updated: true }); break;
      }
      case 'backend': {
        const profiles = new Profiles(config, store, new Signer(config.backend_signing_key));
        if (sub === 'use') profiles.select(argv[2]);
        if (sub === 'key') { process.stdout.write(new Signer(config.backend_signing_key).publicPem()); break; }
        const active = store.setting('active_backend') ?? config.active_backend;
        print({ active, backends: profiles.all().map(b => ({ id: b.id, mode: b.mode, profile: b.profile, health_url: b.health_url, active: b.id === active })) });
        break;
      }
      case 'calls': {
        const calls = store.calls(Number(flag(argv, 'limit') ?? 20)).map(call => ({ ...call, lane_ref: undefined, signals: store.signals(call.id), declines: store.declines(call.id), turns: store.turns(call.id).map(t => ({ ...t, fingerprint: undefined })) }));
        print({ calls });
        break;
      }
      case 'requests': print({ requests: store.callRequests(Number(flag(argv, 'limit') ?? 20)) }); break;
      case 'devices': print({ devices: store.devices().map(d => ({ ...d, credential_hash: undefined, push_voip_token: d.push_voip_token ? '(registered)' : null })) }); break;
      case 'tokens': print({ tokens: store.callerTokens().map(t => ({ ...t, secret_hash: undefined })) }); break;
      case 'device-revoke': print({ revoked: store.revokeDevice(sub, at) }); break;
      default:
        process.stderr.write('usage: switchboard serve|pairing-code|connector-credential NAME|backend [list|use ID|key]|calls|requests|devices|tokens|device-revoke ID [--config FILE]\n');
        process.exit(64);
    }
  } finally { store.close(); }
}

if (import.meta.main) await main();
