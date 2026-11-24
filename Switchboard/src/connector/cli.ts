#!/usr/bin/env bun
// switchboard-connector: the call tool an agent uses to ring the user, and the relay that carries a call's turns.
//   switchboard-connector call --subject "..." [--operation-id UUID] [--config FILE]
//   switchboard-connector relay [--config FILE]
// Config: $SWITCHBOARD_CONNECTOR_CONFIG or ~/.config/switchboard/connector.json (docs/connector.md).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSecret, type SecretRef } from './secrets.ts';
import { laneFromConfig, type LaneConfig } from './lanes.ts';
import { Relay } from './relay.ts';

export type ConnectorConfig = {
  /** Switchboard's base as the connector reaches it (loopback on the server host), e.g. http://127.0.0.1:47860 */
  switchboard: string;
  /** The app API path on that base. */
  app_path?: string;
  /** The caller token the user created in the app and stored for the agent. Only `call` reads it. */
  caller_token?: SecretRef;
  /** The connector credential from `switchboard connector-credential`. Only `relay` reads it. */
  connector_credential?: SecretRef;
  lane?: LaneConfig;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function args(argv: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1] ?? ''; i++; } else rest.push(argv[i]);
  }
  return { flags: out, rest };
}

export function loadConnectorConfig(path?: string): ConnectorConfig {
  const file = path || process.env.SWITCHBOARD_CONNECTOR_CONFIG || join(homedir(), '.config/switchboard/connector.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ConnectorConfig;
}

function out(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

/**
 * Places one call to the user. Prints the call (id, state, caller name, subject, ring expiry) and never the token.
 * Exit 0: ringing (or recorded). Exit 2: refused (revoked token, invalid subject, target or backend not ready).
 * Exit 3: uncertain (no answer from Switchboard); rerun with the printed --operation-id, never a new one.
 */
export async function call(config: ConnectorConfig, subject: string, operationId: string = randomUUID()): Promise<number> {
  if (!UUID.test(operationId)) { out({ error: { code: 'validation_error', message: '--operation-id must be a UUID' } }); return 2; }
  if (!config.caller_token) { out({ error: { code: 'unauthorized', message: 'no caller_token configured' } }); return 2; }
  let token: string;
  try { token = readSecret(config.caller_token); } catch (error) { out({ error: { code: 'unauthorized', message: `caller token unreadable: ${(error as Error).message}` } }); return 2; }
  const url = `${config.switchboard}${config.app_path ?? '/voicestack/v1'}/calls`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation_id: operationId, direction: 'incoming', subject }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    out({ uncertain: true, operation_id: operationId, message: `no answer from Switchboard (${String(error).slice(0, 120)}); rerun with --operation-id ${operationId}` });
    return 3;
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) { out({ refused: true, status: response.status, operation_id: operationId, ...body }); return response.status >= 500 && !(body.error as { code?: string })?.code ? 3 : 2; }
  out({ operation_id: operationId, ...body });
  return 0;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags } = args(argv);
  if (command === 'call') {
    if (!flags.subject) { out({ error: { code: 'validation_error', message: 'usage: switchboard-connector call --subject "..." [--operation-id UUID]' } }); process.exit(2); }
    process.exit(await call(loadConnectorConfig(flags.config), flags.subject, flags['operation-id'] || undefined));
  }
  if (command === 'relay') {
    const config = loadConnectorConfig(flags.config);
    if (!config.connector_credential || !config.lane) throw new Error('relay needs connector_credential and lane in the config');
    const credential = config.connector_credential;
    const relay = new Relay({ switchboard: config.switchboard, credential: () => readSecret(credential), lane: laneFromConfig(config.lane) }).start();
    process.on('SIGTERM', () => { relay.stop(); process.exit(0); });
    process.on('SIGINT', () => { relay.stop(); process.exit(0); });
    return;
  }
  process.stderr.write('usage: switchboard-connector call --subject "..." [--operation-id UUID] [--config FILE]\n       switchboard-connector relay [--config FILE]\n');
  process.exit(64);
}

if (import.meta.main) await main();
