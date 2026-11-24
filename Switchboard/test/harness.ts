import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSwitchboard, type Switchboard } from '../src/server/app.ts';
import type { Config } from '../src/server/config.ts';
import { ApnsStub } from '../src/stubs/apns-stub.ts';
import { StubDevice } from '../src/stubs/devices.ts';
import { Relay } from '../src/connector/relay.ts';
import { ScriptedLane, type LaneTurn } from '../src/connector/lanes.ts';

/** The fixtures' own addresses, so handout and text-channel URLs compare exactly. */
export const FIXTURE_BASE = 'https://switchboard.fixture.invalid/voicestack/v1';

export type Harness = {
  switchboard: Switchboard; apns: ApnsStub; lane: ScriptedLane; relay: Relay; dir: string;
  appBase: string; backendReady: { value: boolean };
  device(platform: 'ios' | 'macos', name: string, installationId?: string): StubDevice;
  pairedDevice(platform: 'ios' | 'macos', name: string): Promise<StubDevice>;
  stop(): void;
};

export async function harness(options: { replies?: (turn: LaneTurn, laneRef: string) => string[]; steer?: boolean; ringSeconds?: number; ready?: () => Promise<boolean>; catalog?: () => Promise<{id:string;label:string;project:string}[]>; config?: Partial<Config> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-test-'));
  const apns = new ApnsStub();
  const backendReady = { value: true };
  const config: Config = {
    listen: { host: '127.0.0.1', port: 0 },
    public_base: FIXTURE_BASE,
    database: join(dir, 'switchboard.sqlite'),
    backend_signing_key: join(dir, 'backend-signing-key.pem'),
    ring_seconds: options.ringSeconds ?? 60,
    handout_seconds: 60,
    targets: [
      { id: 'target_main', label: 'Agent', kind: 'main_conversation', is_default: true },
      { id: 'target_fixture_project', label: 'Example project', kind: 'conversation', is_default: false },
    ],
    backends: [
      { id: 'mac-local', mode: 'A', profile: 'voicestack-mode-a-speech/1', transcription_address: 'wss://voice-mac.fixture.invalid/v1/realtime?intent=transcription', speech_address: 'https://voice-mac.fixture.invalid/v1/audio/speech', health_url: 'http://127.0.0.1:1/health', audience: 'voice-mac' },
      { id: 'second', mode: 'A', profile: 'voicestack-mode-a-speech/1', transcription_address: 'wss://voice-second.fixture.invalid/v1/realtime?intent=transcription', speech_address: 'https://voice-second.fixture.invalid/v1/audio/speech', health_url: 'http://127.0.0.1:1/health', audience: 'voice-second' },
    ],
    active_backend: 'mac-local',
    push: { kind: 'stub', base_url: apns.url },
    ...options.config,
  };
  const switchboard = startSwitchboard({ config, ready: options.ready ?? (async () => backendReady.value), log: () => {} });
  const lane = new ScriptedLane(options.steer ?? false, options.replies ?? (() => ['Use the narrower ', 'boundary first.']), { target_main: 'conversation-1', target_fixture_project: 'project-conversation' });
  if (options.catalog) Object.assign(lane, { catalog: options.catalog });
  const { secret } = switchboard.admin.connectorCredential('test');
  const relay = new Relay({ switchboard: switchboard.url, credential: () => secret, lane, log: () => {}, reconnect: false }).start();
  await relay.ready;
  const appBase = `${switchboard.url}/voicestack/v1`;
  const device = (platform: 'ios' | 'macos', name: string, installationId?: string) => new StubDevice(appBase, platform, name, installationId);
  return {
    switchboard, apns, lane, relay, dir, appBase, backendReady, device,
    async pairedDevice(platform, name) {
      const d = device(platform, name);
      await d.pair(switchboard.admin.pairingCode());
      await d.ack();
      return d;
    },
    stop() { relay.stop(); switchboard.stop(); apns.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export const uuid = () => crypto.randomUUID();
