import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Target = { id: string; label: string; kind: 'main_conversation' | 'conversation'; is_default: boolean };

/** One voice backend. Apps get its addresses and a short-lived credential per call; they never choose it. */
export type Backend = {
  id: string;
  mode: 'A';
  profile: string;
  transcription_address: string;
  speech_address: string;
  /** Readiness probe; ready means it answers {"status":"ok"} (Docs/PROTOCOL.md section 6). */
  health_url: string;
  /** Audience the backend checks in the credential. */
  audience: string;
  label?: string;
  settings_address?: string;
  provider?: 'mode-a' | 'openai';
  voice?: string;
  transcription_model?: string;
  speech_model?: string;
  /** Private server-side file; never returned to devices or the settings page. */
  key_file?: string;
};

export type PushConfig =
  | { kind: 'stub'; base_url: string }
  | { kind: 'off' };

export type Config = {
  listen: { host: string; port: number };
  /** The app-facing base, e.g. https://switchboard.example.ts.net:9450/voicestack/v1 (TLS ends at tailscale serve). */
  public_base: string;
  database: string;
  /** Ed25519 private key (PKCS#8 PEM) signing backend credentials; created on first start. */
  backend_signing_key: string;
  ring_seconds: number;
  handout_seconds: number;
  targets: Target[];
  backends: Backend[];
  /** The active backend unless `switchboard backend use ID` stored another. */
  active_backend: string;
  push: PushConfig;
};

export const PROFILE_APP = 'voicestack-app/1';
export const PROFILE_SPEECH_A = 'voicestack-mode-a-speech/1';

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const base = dirname(resolve(path));
  const config: Config = {
    listen: raw.listen ?? { host: '127.0.0.1', port: 47860 },
    public_base: required(raw.public_base, 'public_base'),
    database: resolve(base, raw.database ?? 'var/switchboard.sqlite'),
    backend_signing_key: resolve(base, raw.backend_signing_key ?? 'var/backend-signing-key.pem'),
    ring_seconds: raw.ring_seconds ?? 60,
    handout_seconds: raw.handout_seconds ?? 60,
    targets: raw.targets ?? [{ id: 'target_main', label: 'Agent', kind: 'main_conversation', is_default: true }],
    backends: raw.backends ?? [],
    active_backend: required(raw.active_backend, 'active_backend'),
    push: raw.push ?? { kind: 'off' },
  };
  return checkConfig(config);
}

export function checkConfig(config: Config): Config {
  if (!/^https:\/\/[^/]+\/.+[^/]$/.test(config.public_base)) throw new Error('public_base must be an https URL with a path and no trailing slash');
  if (config.targets.filter(t => t.is_default).length !== 1) throw new Error('exactly one target must be the default');
  if (!config.backends.some(b => b.id === config.active_backend)) throw new Error(`active_backend ${config.active_backend} is not in backends`);
  for (const backend of config.backends) {
    if (backend.mode !== 'A') throw new Error(`backend ${backend.id}: only mode A is supported`);
    if (backend.profile !== PROFILE_SPEECH_A) throw new Error(`backend ${backend.id}: profile must be ${PROFILE_SPEECH_A}`);
  }
  return config;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`config: ${name} is required`);
  return value;
}
