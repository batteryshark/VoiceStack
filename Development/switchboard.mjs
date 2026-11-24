import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { jsonBody, json, safeError } from '../Backend/ModeAAdapter/server.mjs';
import { Fault, PROFILE, keys, event } from '../Backend/ModeAAdapter/protocol.mjs';

const now = () => new Date().toISOString();
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function createSwitchboard({ issueCredential, speechOrigin, tls }) {
  const devices = new Map(), tokens = new Map(), calls = new Map(), operations = new Map(), clients = new Set();
  const usedCodes = new Set(); let serial = 0, base, mainBinding = 'binding_main_1';
  let phonePolicy = { calls_allowed: true, valid_until: '2999-01-01T00:00:00Z' };
  const state = { devices, tokens, calls, operations, dropped: new Set(), dropNext: false, setMainBinding: value => { mainBinding = value; } };
  const targets = [{ id: 'target_main', label: 'Agent', kind: 'main_conversation', is_default: true, available: true }, { id: 'target_fixture_project', label: 'Example project', kind: 'conversation', is_default: false, available: true }];
  const send = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
  const broadcast = (message, except) => { for (const c of clients) if (c.device !== except) send(c.ws, message); };
  const bearer = req => req.headers.authorization?.replace(/^Bearer /, '');
  const authorize = req => {
    const secret = bearer(req), device = [...devices.values()].find(d => d.credential === secret);
    if (device) return { device };
    const token = [...tokens.values()].find(t => t.secret === secret);
    if (!token) throw new Fault('unauthorized', 'Unauthorized', 401);
    if (token.state === 'revoked') throw new Fault('token_revoked', 'Token revoked', 403);
    return { token };
  };
  const publicToken = t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'secret'));
  const handout = call => ({ mode: 'A', profile: PROFILE, transcription_address: speechOrigin.replace(/^http/, 'ws') + '/v1/realtime?intent=transcription', speech_address: speechOrigin + '/v1/audio/speech', credential: issueCredential(call.id), expires_at: new Date(Date.now() + 120000).toISOString() });
  const own = (call, device) => {
    if (!call || call.state === 'ended') throw new Fault('call_not_active', 'Call not active', 409);
    if (!device || call.owner_device_id !== device.id) throw new Fault('call_taken', 'Another device owns this call', 409);
  };
  const end = (call, reason) => {
    call.state = 'ended'; const message = event('call.ended', { call_id: call.id, reason }); broadcast(message);
    for (const ws of call.sockets ?? []) send(ws, message);
  };
  const publicCall = call => Object.fromEntries(Object.entries(call).filter(([k]) => !['sockets', 'turns', 'token_id'].includes(k)));
  const policyAllowed = () => phonePolicy.calls_allowed && Date.parse(phonePolicy.valid_until) > Date.now();
  function mutate(actor, path, body, perform) {
    if (!uuid(body.operation_id)) throw new Fault('validation_error', 'UUID operation_id required');
    const key = `${actor}:${body.operation_id}`, hash = path + canonical(body);
    if (operations.has(key)) {
      const old = operations.get(key); if (old.hash !== hash) throw new Fault('operation_conflict', 'Operation body changed', 409); return old.result;
    }
    const result = perform(); operations.set(key, { hash, result }); return result;
  }
  const handler = async (req, res) => {
    let operationID;
    try {
      const path = new URL(req.url, base).pathname.replace(/^\/voicestack\/v1/, '');
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await jsonBody(req) : {};
      operationID = body.operation_id;
      if (path === '/pair' && req.method === 'POST') {
        keys(body, ['profile', 'pairing_code', 'device']); keys(body.device, ['installation_id', 'name', 'platform', 'app_version']);
        if (body.profile !== 'voicestack-app/1') throw new Fault('profile_unsupported', 'Unsupported profile');
        if (!['fixture-one-use-code-mac', 'fixture-one-use-code-ios'].includes(body.pairing_code) || usedCodes.has(body.pairing_code)) throw new Fault('unauthorized', 'Pairing code unavailable', 401);
        if (!uuid(body.device.installation_id) || !['ios', 'macos'].includes(body.device.platform)) throw new Fault('validation_error');
        usedCodes.add(body.pairing_code); const id = `dev_${++serial}`;
        const d = { ...body.device, id, credential: `fixture-device-${randomUUID()}`, paired: false, paired_at: now() }; devices.set(id, d);
        return json(res, 200, { device_id: id, device_credential: d.credential, paired_at: d.paired_at, profile: 'voicestack-app/1' });
      }
      const auth = authorize(req), d = auth.device, t = auth.token;
      if (t && !(path === '/calls' && req.method === 'POST' && body.direction === 'incoming')) throw new Fault('forbidden', 'Caller token can only request calls', 403);
      if (req.method === 'GET') {
        if (path === '/me') return json(res, 200, { device_id: d.id, acknowledged: d.paired, platform: d.platform });
        if (path === '/targets') return json(res, 200, { targets });
        if (path === '/caller-tokens') return json(res, 200, { tokens: [...tokens.values()].map(publicToken) });
        const call = calls.get(path.split('/')[2]);
        if (path.startsWith('/calls/') && call) return json(res, 200, { call: publicCall(call) });
        throw new Fault('validation_error', 'Unknown route', 404);
      }
      const result = mutate(d?.id ?? t.id, `${req.method} ${path}`, body, () => {
        if (path === '/pair/ack' && req.method === 'POST') {
          keys(body, ['operation_id', 'installation_id']); if (body.installation_id !== d.installation_id) throw new Fault('forbidden', 'Installation mismatch', 403);
          d.paired = true; return [200, { paired: true, device_id: d.id }];
        }
        if (!t && !d.paired) throw new Fault('forbidden', 'Pairing acknowledgement required', 403);
        if (path === '/devices/me/push' && req.method === 'PUT') {
          keys(body, ['operation_id', 'environment', 'bundle_id', 'voip_token']); if (d.platform !== 'ios') throw new Fault('forbidden', 'Phone only', 403);
          return [200, { registered: true }];
        }
        if (path === '/devices/me/availability' && req.method === 'PUT') {
          keys(body, ['operation_id', 'calls_allowed', 'reason', 'valid_until']);
          if (d.platform !== 'ios') throw new Fault('forbidden', 'Phone only', 403);
          if (!['available', 'focus', 'quiet_hours', 'calls_disabled'].includes(body.reason) || typeof body.calls_allowed !== 'boolean' || !Number.isFinite(Date.parse(body.valid_until))) throw new Fault('validation_error');
          phonePolicy = body;
          if (!policyAllowed()) for (const call of calls.values()) if (call.state === 'ringing') end(call, body.reason);
          return [200, { updated: true }];
        }
        if (path === '/caller-tokens' && req.method === 'POST') {
          keys(body, ['operation_id', 'name']); if (typeof body.name !== 'string' || !body.name.trim()) throw new Fault('validation_error');
          const token = { id: `ctok_${++serial}`, name: body.name.trim(), state: 'active', created_at: now(), last_used_at: null, secret: `fixture-caller-${randomUUID()}` }; tokens.set(token.id, token);
          return [200, { token: publicToken(token), secret: token.secret }];
        }
        if (path.startsWith('/caller-tokens/')) {
          keys(body, ['operation_id']); const token = tokens.get(path.split('/')[2]); if (!token) throw new Fault('validation_error', 'Unknown token', 404);
          if (req.method === 'POST' && path.endsWith('/revoke')) { token.state = 'revoked'; token.revoked_at = now(); return [200, publicToken(token)]; }
          if (req.method === 'DELETE') { if (token.state === 'active') throw new Fault('token_active', 'Revoke token before deletion', 409); tokens.delete(token.id); return [204, null]; }
        }
        if (path === '/calls' && req.method === 'POST') {
          keys(body, ['operation_id', 'direction', ...(t ? ['subject'] : ['target_id'])]);
          if (t && (typeof body.subject !== 'string' || !body.subject.trim() || [...body.subject.trim()].length > 60)) throw new Fault('validation_error');
          if (t && !policyAllowed()) throw new Fault('forbidden', 'Phone policy prevents ringing', 403);
          const target = targets.find(x => x.id === body.target_id);
          if (!t && (!target || body.direction !== 'outgoing')) throw new Fault('target_unavailable', 'Target unavailable', 409);
          const call = { id: `call_${++serial}`, direction: t ? 'incoming' : 'outgoing', state: t ? 'ringing' : 'connecting', target_binding: t || target.id === 'target_main' ? mainBinding : 'binding_project', sockets: new Set(), turns: new Map() };
          if (t) { Object.assign(call, { caller_name: t.name, subject: body.subject.trim(), ring_expires_at: new Date(Date.now() + 30000).toISOString(), token_id: t.id }); t.last_used_at = now(); }
          else Object.assign(call, { target: { id: target.id, label: target.label }, owner_device_id: d.id, started_at: now() });
          call.text_channel = base.replace(/^http/, 'ws') + `/calls/${call.id}/text`; calls.set(call.id, call);
          if (t) broadcast(event('call.incoming', { call: publicCall(call) }));
          return [200, { call: publicCall(call), ...(!t ? { backend: handout(call) } : {}) }];
        }
        const [, , callID, action] = path.split('/'); const call = calls.get(callID);
        if (!call || call.state === 'ended') throw new Fault('call_not_active', 'Call not active', 409);
        keys(body, ['operation_id', ...(['decline', 'end'].includes(action) ? ['reason'] : [])]);
        if (action === 'accept' && req.method === 'POST') {
          if (call.owner_device_id) throw new Fault('call_taken', 'Call taken', 409);
          if (Date.parse(call.ring_expires_at) <= Date.now() || !policyAllowed()) { end(call, 'expired'); throw new Fault('call_not_active', 'Ring expired', 409); }
          Object.assign(call, { owner_device_id: d.id, state: 'connecting' }); broadcast(event('call.taken', { call_id: call.id }), d.id);
          return [200, { call: publicCall(call), backend: handout(call) }];
        }
        if (action === 'decline' && call.state === 'ringing') {
          if (!['user', 'focus', 'quiet_hours', 'calls_disabled'].includes(body.reason)) throw new Fault('validation_error');
          end(call, body.reason); return [200, { ended: true }];
        }
        own(call, d);
        if (action === 'end') { end(call, body.reason); return [200, { ended: true }]; }
        if (action === 'backend-handoff') return [200, { backend: handout(call) }];
        throw new Fault('validation_error', 'Unknown route', 404);
      });
      if (state.dropNext) { state.dropNext = false; state.dropped.add(operationID); req.socket.destroy(); return; }
      if (result[0] === 204) { res.writeHead(204); res.end(); } else json(res, ...result);
    } catch (e) { json(res, e.status ?? 500, { error: { ...safeError(e), operation_id: operationID } }); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const { device } = authorize(req); if (!device?.paired) throw new Fault('forbidden');
      const path = new URL(req.url, base).pathname.replace(/^\/voicestack\/v1/, '');
      const call = path.match(/^\/calls\/([^/]+)\/text$/)?.[1];
      if (path !== '/device/events') own(calls.get(call), device);
      wss.handleUpgrade(req, socket, head, ws => {
        if (path === '/device/events') {
          const client = { device: device.id, ws }; clients.add(client); ws.on('close', () => clients.delete(client));
          send(ws, event('device.ready', { profile: 'voicestack-app/1' })); return;
        }
        const c = calls.get(call); c.sockets.add(ws); ws.on('close', () => c.sockets.delete(ws));
        send(ws, event('call.ready', { call_id: c.id, target_binding: c.target_binding }));
        ws.on('message', data => {
          try {
            own(c, device); const m = JSON.parse(data); keys(m, ['type', 'operation_id', 'text', 'delivery']);
            if (m.type !== 'turn.submit' || !uuid(m.operation_id) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 16000 || !['queue', 'steer'].includes(m.delivery)) throw new Fault('validation_error');
            const prior = c.turns.get(m.operation_id);
            if (prior) { if (prior.body !== canonical(m)) throw new Fault('operation_conflict', 'Turn body changed', 409); send(ws, prior.accepted); return; }
            const response = `resp_${++serial}`;
            const accepted = { type: 'turn.accepted', operation_id: m.operation_id, response_id: response, requested_delivery: m.delivery, effective_delivery: 'queue', ...(m.delivery === 'steer' ? { fallback_reason: 'steer_not_supported' } : {}), target_binding: c.target_binding };
            c.turns.set(m.operation_id, { body: canonical(m), accepted }); send(ws, accepted);
            const text = 'Use the narrower boundary first.';
            send(ws, { type: 'reply.delta', response_id: response, sequence: 1, delta: text });
            send(ws, { type: 'reply.done', response_id: response, text, status: 'completed' });
          } catch (e) { send(ws, { type: 'error', error: safeError(e) }); }
        });
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  return { server, state, setOrigin(origin) { base = origin + '/voicestack/v1'; }, close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); } };
}
