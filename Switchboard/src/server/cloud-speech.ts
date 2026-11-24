import type { Backend } from './config.ts';
import { verifyCredential } from './backend.ts';
import type { Profiles } from './profiles.ts';
import { fail } from './errors.ts';

type Peer = { send(data: string): unknown; close(code?: number, reason?: string): unknown };
export type CloudConnection = { callId: string; backend: Backend; upstream?: WebSocket; peer?: Peer; pending: string[]; bytes: number; timer?: Timer };

/** Only speech conversion passes through this bridge. The text lane to the agent is unchanged. */
export class CloudSpeech {
  readonly connections = new Set<CloudConnection>();
  constructor(readonly profiles: Profiles, readonly request: typeof fetch = fetch,
    readonly connect = (url: string, key: string) => new WebSocket(url, { headers: { Authorization: 'Bearer ' + key } } as unknown as string[])) {}
  authorize(request: Request, callId: string) {
    const call = this.profiles.store.call(callId);
    if (!call || !['connecting', 'active'].includes(call.state)) throw fail('call_not_active', 'Call is not active');
    const p = this.profiles.forCall(call);
    if (p.provider !== 'openai') throw fail('forbidden', 'This call uses a direct speech server');
    try {
      const claims = verifyCredential(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', this.profiles.signer.publicKey,
        { aud: p.audience, profile: p.profile, call_id: callId, nowMs: Date.now() });
      if (claims.device_id !== call.owner_device_id || claims.binding !== call.target_binding) throw Error();
    } catch { throw fail('unauthorized', 'Invalid call credential'); }
    return p;
  }
  async speech(request: Request, p: Backend) {
    const b = await request.json() as Record<string, unknown>;
    if (b.model !== 'local-breeze' || b.voice !== 'local-default' || typeof b.input !== 'string' || b.input.length > 12000 || !['pcm', 'wav'].includes(String(b.response_format))) throw fail('validation_error', 'Invalid speech request');
    const result = await this.request(p.speech_address, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
      headers: { authorization: 'Bearer ' + this.profiles.key(p), 'content-type': 'application/json' },
      body: JSON.stringify({ model: p.speech_model, voice: p.voice || 'coral', input: b.input, response_format: b.response_format }) });
    if (!result.ok) { await result.body?.cancel(); throw fail('backend_unavailable', 'Cloud speech failed; check provider access and quota'); }
    return new Response(result.body, { headers: { 'content-type': b.response_format === 'pcm' ? 'audio/pcm' : 'audio/wav', 'cache-control': 'no-store' } });
  }
  open(c: CloudConnection, peer: Peer) {
    c.peer = peer; this.connections.add(c);
    try {
      const upstream = this.connect(c.backend.transcription_address, this.profiles.key(c.backend)); c.upstream = upstream;
      c.timer = setTimeout(() => this.close(c, 'Cloud transcription timed out'), 15000);
      upstream.onopen = () => { clearTimeout(c.timer); for (const m of c.pending) upstream.send(m); c.pending = []; c.bytes = 0; };
      upstream.onmessage = e => {
        try {
          const m = JSON.parse(String(e.data));
          if (m.type === 'session.created' || m.type === 'session.updated') {
            if (m.session?.audio?.input?.transcription) m.session.audio.input.transcription.model = 'local-parakeet';
          }
          if (m.type === 'error') m.error = { message: 'Cloud transcription failed; check provider access and quota' };
          peer.send(JSON.stringify(m));
        } catch { this.close(c, 'Invalid cloud transcription response'); }
      };
      upstream.onerror = () => this.close(c, 'Cloud transcription unavailable');
      upstream.onclose = () => this.close(c, 'Cloud transcription closed');
    } catch { this.close(c, 'Cloud transcription unavailable'); }
  }
  message(c: CloudConnection, raw: string) {
    try {
      if (raw.length > 262144) throw Error();
      const m = JSON.parse(raw);
      if (m.type === 'session.update') {
        // Normalize the frozen app protocol, rather than forwarding arbitrary session settings.
        m.session = { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null,
          transcription: { model: c.backend.transcription_model } } } };
      } else if (!['input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.clear'].includes(m.type)) throw Error();
      const text = JSON.stringify(m);
      if (c.upstream?.readyState === WebSocket.OPEN) c.upstream.send(text);
      else { c.bytes += text.length; if (c.bytes > 1048576) throw Error(); c.pending.push(text); }
    } catch { this.close(c, 'Invalid transcription message'); }
  }
  close(c: CloudConnection, reason = 'Call ended') {
    if (!this.connections.delete(c)) return;
    clearTimeout(c.timer); c.pending = []; c.bytes = 0;
    c.upstream?.close(); c.peer?.close(1000, reason);
  }
  end(callId?: string) { for (const c of this.connections) if (!callId || c.callId === callId) this.close(c); }
}
