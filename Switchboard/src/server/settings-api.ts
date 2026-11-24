import { fail } from './errors.ts';
import type { Profiles } from './profiles.ts';

export function settingsAPI(profiles: Profiles) {
  const sessions = new Map<string, number>();
  let attempts = 0, windowStart = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  return async (request: Request, path: string) => {
    if (!path.startsWith('/settings/api/')) return undefined;
    const origin = request.headers.get('origin');
    if (origin && ![new URL(request.url).origin, new URL(profiles.config.public_base).origin].includes(origin)) throw fail('forbidden', 'Use the Switchboard settings page');
    const payload = async () => {
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw fail('validation_error', 'Expected JSON');
      const text = await request.text();
      if (text.length > 16000) throw fail('validation_error', 'Settings request too large');
      let body; try { body = JSON.parse(text); } catch { throw fail('validation_error', 'Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('validation_error', 'Expected an object');
      return body;
    };
    if (path === '/settings/api/login' && request.method === 'POST') {
      if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
      if (++attempts > 15) return json({ error: { message: 'Too many attempts. Try again in a minute.' } }, 429);
      const hash = profiles.store.setting('admin_password_hash');
      const body = await payload();
      if (!hash || typeof body.password !== 'string' || !await Bun.password.verify(body.password, hash)) throw fail('unauthorized', 'Incorrect settings password');
      const token = crypto.randomUUID() + crypto.randomUUID();
      for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
      sessions.set(token, Date.now() + 8 * 3600000); attempts = 0;
      return json({ token });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if ((sessions.get(token) ?? 0) <= Date.now()) throw fail('unauthorized', 'Sign in to Switchboard settings');
    if (path === '/settings/api/logout') { sessions.delete(token); return json({ ok: true }); }
    if (path === '/settings/api/profiles' && request.method === 'GET') return json({
      active: profiles.active().id, profiles: profiles.all().map(p => profiles.public(p)),
      calls: profiles.store.callsInState('ringing', 'connecting', 'active').map(c => ({ id: c.id, state: c.state, profile: c.backend_id })),
    });
    if (path === '/settings/api/profiles' && request.method === 'PUT') return json(profiles.save(await payload()));
    if (path === '/settings/api/default' && request.method === 'PUT') {
      profiles.select((await payload()).id); return json({ active: profiles.active().id });
    }
    const match = /^\/settings\/api\/profiles\/([a-zA-Z0-9_-]+)(?:\/(voices|check))?$/.exec(path);
    if (match) {
      const p = profiles.get(match[1]);
      if (request.method === 'DELETE' && !match[2]) { profiles.remove(p.id); return json({ ok: true }); }
      if (request.method === 'GET' && match[2] === 'voices') return json(await profiles.voices(p));
      if (request.method === 'POST' && match[2] === 'check') {
        // No speech warm-up, synthetic audio, or paid inference on this check.
        if (p.provider === 'openai') {
          const response = await fetch(p.health_url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: 'Bearer ' + profiles.key(p) } });
          if (!response.ok) throw fail('backend_unavailable', 'Cloud authentication/catalog check failed');
          const body = await response.json() as { data: { id: string }[] };
          const models = new Set(body.data.map(m => m.id));
          return json({ ok: models.has(p.speech_model!) && models.has(p.transcription_model!), message: 'Credential checked; selected models ' + (models.has(p.speech_model!) && models.has(p.transcription_model!) ? 'are listed' : 'were not both listed') + '. Audio not tested.' });
        }
        if (!p.settings_address) return json({ ok: false, message: 'Configured. No lightweight catalog check is available; audio not tested.' });
        await profiles.voices(p); return json({ ok: true, message: 'Voice catalog reachable. Audio not tested; no models were warmed.' });
      }
    }
    return json({ error: { message: 'Unknown settings operation' } }, 404);
  };
}
