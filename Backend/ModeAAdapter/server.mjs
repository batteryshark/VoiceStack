import { StablePartial } from './partials.mjs';
import https from 'node:https';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { PCM24To16, validateWAV } from './audio.mjs';
import { capabilities, configuration, validateUpdate, validateSpeech, keys, event, Fault } from './protocol.mjs';

export async function jsonBody(req, limit = 32768) {
  const chunks = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > limit) throw new Fault('validation_error', 'Request too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new Fault('validation_error', 'Invalid JSON'); }
}
export function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
export function safeError(error) { return { code: error instanceof Fault ? error.code : 'backend_unavailable', message: error instanceof Fault ? error.message : 'Speech service unavailable', retryable: false }; }
export async function boundedBytes(response, limit = 24_000 * 2 * 180 + 4096) {
  if (!response.ok) throw new Fault('backend_unavailable', 'Speech service unavailable', 502);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Fault('backend_unavailable', 'Speech output too large', 502); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function localUpstreams({ parakeet = 'ws://127.0.0.1:8446/v1/transcribe', breeze = 'http://127.0.0.1:8444/v1/audio/speech', voice = 'default' } = {}) {
  for (const address of [parakeet, breeze]) if (!['127.0.0.1', '[::1]', 'localhost'].includes(new URL(address).hostname)) throw new Error('Speech upstreams must be loopback');
  const chosenVoice = () => typeof voice === 'function' ? voice() : voice;
  const speech = async (body, previewVoice, signal = AbortSignal.timeout(30000)) => {
    // WAV carries verifiable format metadata; raw PCM alone cannot establish sample rate.
    const response = await fetch(breeze, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, voice: previewVoice ?? chosenVoice(), response_format: 'wav' }), signal });
    const data = await boundedBytes(response); const pcm = validateWAV(data);
    return body.response_format === 'wav' ? data : pcm;
  };
  const recognize = (onResult, onFailure, onPartial = () => {}, onSnapshot = () => {}) => {
    const address = new URL(parakeet); address.searchParams.set('partials', '1');
    const partial = new StablePartial();
    const socket = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    let text = '', committed = false, finished = false;
    const queue = []; let queued = 0;
    const fail = () => { if (!finished) { finished = true; onFailure(); socket.terminate(); } };
    const timer = setTimeout(fail, 100000); timer.unref();
    socket.on('open', () => { for (const data of queue) socket.send(data); queue.length = 0; queued = 0; });
    socket.on('message', (data, binary) => {
      if (binary) return fail();
      try { const m = JSON.parse(data); if (m.type === 'transcript' && typeof m.text === 'string') { text += m.text; if (text.length > 16000) fail(); } else if (m.type === 'transcript.partial' && typeof m.text === 'string' && m.text.length <= 16000) { if (!finished) onSnapshot(m.text); const delta = partial.append(m.text); if (delta && !finished) onPartial(delta); } else fail(); } catch { fail(); }
    });
    socket.on('error', fail);
    socket.on('close', code => { clearTimeout(timer); if (!finished) { finished = true; if (code === 1000 && committed) onResult(text); else onFailure(); } });
    const send = data => {
      if (finished || socket.bufferedAmount > 2 * 1024 * 1024) return fail();
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else if (socket.readyState === WebSocket.CONNECTING) { queued += data.length; if (queued > 2 * 1024 * 1024) return fail(); queue.push(data); }
      else fail();
    };
    return { append: send, commit: () => { committed = true; send(JSON.stringify({ type: 'input_audio.end' })); }, cancel: () => { finished = true; clearTimeout(timer); socket.terminate(); } };
  };
  let lastReady = 0, warming = null;
  const ready = () => {
    if (Date.now() - lastReady < 15000) return Promise.resolve(true);
    // A phone retry and Switchboard preflight must not queue separate synthetic
    // TTS requests behind the same model reload.
    if (warming) return warming;
    warming = (async () => {
      try {
        await Promise.all([
          speech({ model: 'local-breeze', voice: 'local-default', input: 'Ready.', response_format: 'wav' }, undefined, AbortSignal.timeout(12000)),
          new Promise((resolve, reject) => {
            let stream;
            const timer = setTimeout(() => { stream.cancel(); reject(new Error('timeout')); }, 12000);
            stream = recognize(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new Error('unavailable')); });
            stream.append(Buffer.alloc(3200)); stream.commit();
          })
        ]); lastReady = Date.now(); return true;
      } catch { return false; }
      finally { warming = null; }
    })();
    return warming;
  };
  async function* streamPCM(body, signal) {
    // Readiness validates a real WAV from this same local service as mono PCM16.
    // The gateway also declares rate and sample format on each streamed response.
    if (!await ready()) throw new Fault('backend_unavailable', 'Speech services are not ready', 503);
    const response = await fetch(breeze, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, voice: chosenVoice(), response_format: 'pcm' }), signal: AbortSignal.any([AbortSignal.timeout(60000), signal]) });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/pcm' || response.headers.get('x-sample-rate') !== '24000' || response.headers.get('x-sample-format') !== 's16le' || (response.headers.has('x-channels') && response.headers.get('x-channels') !== '1')) {
      await response.body?.cancel(); throw new Fault('backend_unavailable', 'Unverified streaming PCM format', 502);
    }
    let odd = Buffer.alloc(0), size = 0;
    for await (const chunk of response.body) {
      const data = Buffer.concat([odd, Buffer.from(chunk)]); const end = data.length - data.length % 2;
      odd = data.subarray(end); size += chunk.length;
      if (size > 48000 * 180) throw new Fault('backend_unavailable', 'Speech output too large', 502);
      for (let p = 0; p < end; p += 4800) yield data.subarray(p, Math.min(p + 4800, end));
    }
    if (odd.length || !size) throw new Fault('backend_unavailable', 'Incomplete PCM output', 502);
  }
  return { speech, recognize, ready, streamPCM };
}

export function createAdapter({ tls, verifyCredential, upstreams, settings, verifyManagement, development = false }) {
  if (!tls && !development) throw new Error('TLS is required');
  const handler = async (req, res) => {
    try {
      const path = new URL(req.url, 'https://adapter.invalid').pathname;
      if (path.startsWith('/admin/speech')) {
        if (!settings || !verifyManagement) throw new Fault('unsupported_feature', 'Speech settings unavailable', 404);
        verifyManagement(req.headers.authorization, req.method, path);
        if (req.method === 'GET' && path === '/admin/speech') return json(res, 200, await settings.snapshot());
        if (req.method === 'PUT' && path === '/admin/speech') {
          const body = await jsonBody(req); keys(body, ['voice', 'operation_id']);
          return json(res, 200, await settings.set(body.voice, body.operation_id));
        }
        if (req.method === 'POST' && path === '/admin/speech/preview') {
          const body = await jsonBody(req); keys(body, ['voice']); await settings.validate(body.voice);
          const pcm = await upstreams.speech({ model: 'local-breeze', voice: 'local-default', input: 'This is a preview of the selected voice.', response_format: 'pcm' }, body.voice);
          res.writeHead(200, { 'content-type': 'audio/pcm', 'cache-control': 'no-store' }); res.end(pcm); return;
        }
        throw new Fault('unsupported_feature', 'Unsupported management route', 404);
      }
      // Probes are non-secret; TLS/tailnet ACL authenticates their network route.
      if (req.method === 'GET' && ['/health', '/v1/capabilities'].includes(path)) {
        if (!await upstreams.ready()) throw new Fault('backend_unavailable', 'Speech services are not ready', 503);
        return json(res, 200, path === '/health' ? { status: 'ok' } : capabilities);
      }
      verifyCredential(req.headers.authorization);
      if (req.method !== 'POST' || path !== '/v1/audio/speech') throw new Fault('unsupported_feature', 'Unsupported route', 404);
      const body = validateSpeech(await jsonBody(req));
      if (body.response_format === 'pcm' && upstreams.streamPCM) {
        const controller = new AbortController(); res.on('close', () => controller.abort());
        for await (const chunk of upstreams.streamPCM(body, controller.signal)) {
          verifyCredential(req.headers.authorization);
          if (res.destroyed) break;
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'audio/pcm', 'cache-control': 'no-store' });
          if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
        }
        if (!res.destroyed) res.end(); return;
      }
      const audio = await upstreams.speech(body);
      verifyCredential(req.headers.authorization);
      if (body.response_format === 'wav') validateWAV(audio);
      else if (!audio.length || audio.length % 2) throw new Fault('backend_unavailable', 'Invalid PCM output', 502);
      res.writeHead(200, { 'content-type': body.response_format === 'wav' ? 'audio/wav' : 'audio/pcm', 'cache-control': 'no-store' });
      for (let i = 0; i < audio.length && !res.destroyed; i += 4800) {
        if (!res.write(audio.subarray(i, i + 4800))) await once(res, 'drain');
      }
      res.end();
    } catch (e) { if (!res.headersSent) json(res, e.status ?? 502, { error: safeError(e) }); else res.destroy(); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'https://adapter.invalid');
      if (url.pathname !== '/v1/realtime' || url.search !== '?intent=transcription') throw new Fault('unsupported_feature');
      const claims = verifyCredential(req.headers.authorization);
      wss.handleUpgrade(req, socket, head, ws => realtime(ws, req.headers.authorization, claims, req.headers['x-voicestack-live-preview'] === 'snapshots-v1'));
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  function realtime(ws, authorization, claims, snapshots) {
    let configured = false, turn = null, previous = null;
    const session = { id: `sess_${randomUUID()}`, ...configuration() };
    const send = (type, fields) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1024 * 1024) ws.close(1013); else ws.send(JSON.stringify(event(type, fields))); } };
    send('session.created', { session });
    const expiry = setTimeout(() => ws.close(1008, 'Credential expired'), Math.max(1, claims.exp * 1000 - Date.now())); expiry.unref();
    const cleanup = () => { turn?.stream.cancel(); turn = null; clearTimeout(expiry); };
    ws.on('close', cleanup); ws.on('error', cleanup);
    const begin = () => {
      const t = { converter: new PCM24To16(), stream: null, bytes: 0, committed: false, id: `item_${randomUUID()}` };
      turn = t;
      t.stream = upstreams.recognize(transcript => {
        if (turn !== t) return;
        if (!t.committed) { fail(t); return; }
        send('conversation.item.input_audio_transcription.completed', { item_id: t.id, content_index: 0, transcript, usage: { type: 'duration', seconds: t.bytes / 48000 } });
        turn = null;
      }, () => fail(t), delta => {
        if (turn === t && !snapshots) send('conversation.item.input_audio_transcription.delta', { item_id: t.id, content_index: 0, delta });
      }, text => {
        if (turn === t && snapshots) send('voicestack.input_audio_transcription.preview', { item_id: t.id, content_index: 0, text });
      });
      return t;
    };
    const fail = t => {
      if (turn !== t) return;
      if (t.committed) send('conversation.item.input_audio_transcription.failed', { item_id: t.id, content_index: 0, error: { type: 'server_error', code: 'backend_unavailable', message: 'Transcription failed', param: null } });
      else send('error', { error: { type: 'server_error', code: 'backend_unavailable', message: 'Transcription failed', param: null } });
      t.stream?.cancel(); turn = null;
    };
    ws.on('message', (raw, binary) => {
      let m;
      try {
        verifyCredential(authorization, claims.call_id);
        if (binary) throw new Fault('unsupported_feature', 'JSON text frames required');
        try { m = JSON.parse(raw); } catch { throw new Fault('validation_error', 'Invalid JSON'); }
        if (m.type === 'session.update') {
          keys(m, ['type', 'event_id', 'session']);
          if (turn) throw new Fault('invalid_state', 'Turn in progress');
          validateUpdate(m.session); configured = true; send('session.updated', { session }); return;
        }
        if (!configured) throw new Fault('invalid_state', 'Configure session before audio');
        keys(m, ['type', 'event_id', ...(m.type === 'input_audio_buffer.append' ? ['audio'] : [])]);
        if (m.type === 'input_audio_buffer.append') {
          if (turn?.committed) throw new Fault('invalid_state', 'One transcription turn at a time');
          if (typeof m.audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.audio)) throw new Fault('validation_error', 'Invalid audio encoding');
          const bytes = Buffer.from(m.audio, 'base64');
          if (!bytes.length || bytes.length > 4800) throw new Fault('validation_error', 'Append must contain at most 100 ms');
          const t = turn ?? begin(); t.bytes += bytes.length;
          if (t.bytes > 48000 * 90) { t.stream.cancel(); turn = null; throw new Fault('validation_error', 'Turn exceeds 90 seconds'); }
          const pcm = t.converter.push(bytes); if (pcm.length) t.stream.append(pcm);
        } else if (m.type === 'input_audio_buffer.commit') {
          const t = turn;
          if (!t?.bytes || t.committed) throw new Fault('invalid_state', 'No uncommitted audio');
          const tail = t.converter.push(Buffer.alloc(0), true);
          if (tail.length) t.stream.append(tail);
          t.committed = true; send('input_audio_buffer.committed', { item_id: t.id, previous_item_id: previous }); previous = t.id; t.stream.commit();
        } else if (m.type === 'input_audio_buffer.clear') {
          if (turn?.committed) throw new Fault('invalid_state', 'Committed turn cannot be cleared');
          turn?.stream.cancel(); turn = null; send('input_audio_buffer.cleared');
        } else throw new Fault('unsupported_feature', 'Unsupported Realtime event');
      } catch (e) { send('error', { error: { type: 'invalid_request_error', ...safeError(e), param: e.param ?? null, event_id: m?.event_id ?? null } }); }
    });
  }
  return { server, close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); } };
}
