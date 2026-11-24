import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backend, Config } from './config.ts';
import { PROFILE_SPEECH_A } from './config.ts';
import type { Store, Call } from './store.ts';
import type { Signer } from './backend.ts';
import { fail } from './errors.ts';

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

/** Profile edits reuse the existing settings table. Each call keeps a private snapshot. */
export class Profiles {
  constructor(readonly config: Config, readonly store: Store, readonly signer: Signer) {}
  all(): Backend[] { return JSON.parse(this.store.setting('voice_profiles') ?? JSON.stringify(this.config.backends)); }
  get(id: string): Backend {
    const profile = this.all().find(p => p.id === id);
    if (!profile) throw fail('validation_error', 'Unknown voice profile');
    return profile;
  }
  active() { return this.get(this.store.setting('active_backend') ?? this.config.active_backend); }
  select(id: string) {
    const p = this.get(id);
    if (p.provider === 'openai' && !p.key_file) throw fail('validation_error', 'Add an API key before using this cloud profile');
    this.store.setSetting('active_backend', id);
  }
  public(profile: Backend) {
    const { key_file, ...visible } = profile;
    return { ...visible, has_key: !!key_file, provider: profile.provider ?? 'mode-a' };
  }
  pin(call: Call, profile: Backend) { this.store.setSetting('call_backend:' + call.id, JSON.stringify(profile)); }
  forCall(call: Call): Backend {
    const stored = this.store.setting('call_backend:' + call.id);
    if (stored) return JSON.parse(stored);
    // Compatibility for a pre-upgrade call: keep its own backend, never today's default.
    const profile = this.get(call.backend_id!); this.pin(call, profile); return profile;
  }
  save(raw: Record<string, unknown>) {
    const string = (name: string, fallback = '') => {
      const v = raw[name] ?? fallback;
      if (typeof v !== 'string' || v.length > 2048) throw fail('validation_error', `Invalid ${name}`);
      return v.trim();
    };
    const id = string('id');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw fail('validation_error', 'Use a short profile ID with letters, numbers or dashes');
    const old = this.all().find(p => p.id === id);
    const provider = string('provider', 'mode-a');
    if (!['mode-a', 'openai'].includes(provider)) throw fail('validation_error', 'Unsupported speech provider');
    const voice = string('voice', provider === 'openai' ? 'coral' : '');
    if (voice && !/^[a-zA-Z0-9_-]{1,80}$/.test(voice)) throw fail('validation_error', 'Invalid voice ID');
    const endpoint = (key: string, protocol: string) => {
      let u: URL; try { u = new URL(string(key)); } catch { throw fail('validation_error', `Invalid ${key}`); }
      if (u.protocol !== protocol || u.username || u.password || u.hash) throw fail('validation_error', `${key} requires ${protocol} without embedded credentials`);
      return u.href;
    };
    const p: Backend = provider === 'openai'
      ? { id, mode: 'A', profile: PROFILE_SPEECH_A, provider, audience: 'switchboard-cloud-' + id,
          transcription_address: 'wss://api.openai.com/v1/realtime?intent=transcription',
          speech_address: 'https://api.openai.com/v1/audio/speech', health_url: 'https://api.openai.com/v1/models',
          transcription_model: string('transcription_model', 'gpt-transcribe'), speech_model: string('speech_model', 'gpt-4o-mini-tts') }
      : { id, mode: 'A', profile: PROFILE_SPEECH_A, provider: 'mode-a', audience: string('audience'),
          transcription_address: endpoint('transcription_address', 'wss:'), speech_address: endpoint('speech_address', 'https:'),
          health_url: endpoint('health_url', 'https:'), ...(string('settings_address') ? { settings_address: endpoint('settings_address', 'https:') } : {}) };
    p.label = string('label', id).slice(0, 120); p.voice = voice;
    if (!p.audience || (provider === 'openai' && (!p.speech_model || !p.transcription_model))) throw fail('validation_error', 'Complete the profile fields');
    if (provider === 'openai') {
      p.key_file = old?.provider === 'openai' ? old.key_file : undefined;
      const key = string('api_key');
      if (key) {
        // A new credential version keeps already-started calls on their original key.
        const folder = join(dirname(this.config.database), 'voice-secrets'); mkdirSync(folder, { recursive: true, mode: 0o700 });
        p.key_file = join(folder, crypto.randomUUID() + '.key'); writeFileSync(p.key_file, key, { mode: 0o600 });
      }
    }
    if (provider === 'openai' && !p.key_file && this.active().id === id) throw fail('validation_error', 'The default cloud profile needs an API key');
    const profiles = this.all().filter(b => b.id !== id); profiles.push(p);
    this.store.setSetting('voice_profiles', JSON.stringify(profiles)); return this.public(p);
  }
  remove(id: string) {
    if (this.active().id === id) throw fail('validation_error', 'Choose another default before removing this profile');
    this.get(id); this.store.setSetting('voice_profiles', JSON.stringify(this.all().filter(p => p.id !== id)));
    // Snapshots and their secret files remain valid for in-progress calls.
  }
  key(p: Backend) {
    if (!p.key_file) throw fail('backend_unavailable', 'Cloud profile needs an API key');
    return readFileSync(p.key_file, 'utf8').trim();
  }
  async voices(p: Backend) {
    if (p.provider === 'openai') return { voice: p.voice ?? 'coral', default_voice: 'coral', voices: OPENAI_VOICES.map(id => ({ id, label: id })) };
    if (!p.settings_address) return { voice: p.voice ?? '', default_voice: '', voices: [], note: 'Enter a voice ID supported by this service' };
    const url = new URL(p.settings_address);
    const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
      authorization: 'Bearer ' + this.signer.management(p, 'GET', url.pathname, Date.now()),
    } });
    if (!result.ok) throw fail('backend_unavailable', 'Voice catalog is unavailable');
    const catalog = await result.json() as { voice: string; default_voice: string; voices: { id: string; label: string }[] };
    return { ...catalog, voice: p.voice || catalog.voice };
  }
}
