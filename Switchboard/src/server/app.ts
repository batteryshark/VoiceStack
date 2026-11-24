import type { Server, ServerWebSocket } from 'bun';
import { type Backend, type Config, PROFILE_APP, checkConfig } from './config.ts';
import { ApiError, fail } from './errors.ts';
import { Store, type Call, type Device, type CallerToken, type Turn } from './store.ts';
import { Signer, backendReady } from './backend.ts';
import { Profiles } from './profiles.ts';
import { settingsAPI } from './settings-api.ts';
import { settingsPage, settingsScript } from './settings-page.ts';
import { CloudSpeech, type CloudConnection } from './cloud-speech.ts';
import { type PushSender, pushSender } from './push.ts';
import * as v from './validate.ts';
import { UUID, canonical, newId, newPairingCode, newSecret, rfc3339, sha256 } from '../common/util.ts';

/**
 * Switchboard: the voicestack-app/1 server (Docs/PROTOCOL.md sections 2 and 3) plus the connector stream.
 * HTTP and WebSocket listen on loopback; tailscale serve terminates TLS on the tailnet.
 */
export type Options = {
  config: Config;
  now?: () => number;
  push?: PushSender;
  /** Readiness check for the active backend; defaults to its health probe. */
  ready?: (backend: Backend) => Promise<boolean>;
  log?: (event: Record<string, unknown>) => void;
};

type Principal =
  | { kind: 'device'; device: Device }
  | { kind: 'caller'; token: CallerToken }
  | { kind: 'connector'; id: string; name: string };

type SocketData =
  | { kind: 'device'; deviceId: string }
  | { kind: 'text'; deviceId: string; callId: string }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'cloud'; connection: CloudConnection };

type Connector = { ws: ServerWebSocket<SocketData>; id: string; steer: boolean; targets: Set<string>; catalog: boolean; version: string };
type LiveTurn = { callId: string; operationId: string; responseId: string; sequence: number; text: string };

const DECLINE_REASONS = ['user', 'focus', 'quiet_hours', 'calls_disabled'] as const;
const AVAILABILITY_REASONS = ['available', 'focus', 'quiet_hours', 'calls_disabled'] as const;
const DELIVERY = ['steer', 'queue'] as const;

export type Switchboard = ReturnType<typeof startSwitchboard>;

export function startSwitchboard(options: Options) {
  const config = checkConfig(options.config);
  const now = options.now ?? Date.now;
  const stamp = () => rfc3339(now());
  const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify({ at: stamp(), ...event })));
  const store = new Store(config.database);
  const signer = new Signer(config.backend_signing_key);
  const profiles = new Profiles(config, store, signer);
  const settings = settingsAPI(profiles);
  const cloud = new CloudSpeech(profiles);
  const push = options.push ?? pushSender(config.push);
  const ready = options.ready ?? (async (backend: Backend) => backend.provider === 'openai' ? !!profiles.key(backend) : backendReady(backend));
  const base = new URL(config.public_base);
  const prefix = base.pathname;
  const wsBase = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}${prefix}`;

  const deviceSockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const textSockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  let connector: Connector | null = null;
  const pendingBinds = new Map<string, { resolve: (laneRef: string) => void; reject: (error: Error) => void; timer: Timer }>();
  const liveTurns = new Map<string, LiveTurn>();
  /** Finished reply text per response, for duplicate submits, held in memory only while the call lasts. */
  const replies = new Map<string, string>();
  const ringTimers = new Map<string, Timer>();
  const inflight = new Map<string, Promise<unknown>>();

  // ---------- helpers ----------
  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: body === null ? {} : { 'content-type': 'application/json' } });
  const event = (type: string, fields: Record<string, unknown>) => ({ type, event_id: newId('evt'), ...fields });
  const textChannel = (callId: string) => `${wsBase}/calls/${callId}/text`;
  const activeBackend = () => profiles.active();
  const handout = (call: Call, deviceId: string) => {
    const backend = profiles.forCall(call);
    const issued = signer.issue(backend, call.id, call.target_binding, deviceId, now(), config.handout_seconds);
    return { mode: backend.mode, profile: backend.profile, transcription_address: backend.provider === 'openai' ? `${wsBase}/voice/${call.id}/realtime` : backend.transcription_address, speech_address: backend.provider === 'openai' ? `${config.public_base}/voice/${call.id}/speech` : backend.speech_address, credential: issued.credential, expires_at: issued.expires_at };
  };
  const sendTo = (sockets: Iterable<ServerWebSocket<SocketData>> | undefined, message: unknown) => {
    if (!sockets) return 0;
    let sent = 0;
    for (const ws of sockets) { try { ws.send(JSON.stringify(message)); sent++; } catch { /* closed */ } }
    return sent;
  };
  const toConnector = (message: unknown) => { if (!connector) return false; try { connector.ws.send(JSON.stringify(message)); return true; } catch { return false; } };

  function bearer(request: Request): string | null {
    const header = request.headers.get('authorization');
    const match = header && /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
    return match ? match[1] : null;
  }
  function principal(request: Request): Principal {
    const secret = bearer(request);
    if (!secret) throw fail('unauthorized', 'missing bearer credential');
    if (secret.startsWith('sbd_')) { const device = store.deviceByCredential(secret); if (device) return { kind: 'device', device }; }
    if (secret.startsWith('sbc_')) {
      const token = store.callerTokenBySecret(secret);
      if (token) return { kind: 'caller', token };
    }
    if (secret.startsWith('sbk_')) { const c = store.connectorBySecret(secret); if (c) return { kind: 'connector', ...c }; }
    throw fail('unauthorized', 'unknown or retired credential');
  }
  function device(request: Request, options: { acknowledged?: boolean; platform?: Device['platform'] } = {}): Device {
    const who = principal(request);
    if (who.kind !== 'device') throw fail('forbidden', who.kind === 'caller' ? 'a caller token can only request a call' : 'device credential required');
    if (options.acknowledged !== false && !who.device.acknowledged_at) throw fail('forbidden', 'pairing is not acknowledged');
    if (options.platform && who.device.platform !== options.platform) throw fail('forbidden', `only the ${options.platform} app uses this route`);
    return who.device;
  }
  const bodies = new WeakMap<Request, unknown>();
  async function body(request: Request): Promise<unknown> {
    const text = await request.text();
    if (!text) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw fail('validation_error', 'body must be JSON'); }
    bodies.set(request, parsed);
    return parsed;
  }
  /** The request's operation_id, for error envelopes of requests that failed validation after naming one. */
  function requestOperation(request: Request): string | null {
    const parsed = bodies.get(request) as { operation_id?: unknown } | undefined;
    return typeof parsed?.operation_id === 'string' && UUID.test(parsed.operation_id) ? parsed.operation_id.toLowerCase() : null;
  }

  /** Mutations are idempotent by operation_id: same body replays the recorded result, a changed body conflicts. */
  async function idempotent(scope: string, operationId: string, payload: unknown, run: () => Promise<{ status: number; body: unknown; record?: unknown }>, replay?: (recorded: unknown) => unknown) {
    const fingerprint = sha256(canonical(payload));
    const key = `${scope}\n${operationId}`;
    while (inflight.has(key)) await inflight.get(key)!.catch(() => undefined);
    const prior = store.operation(scope, operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fail('operation_conflict', 'operation_id was already used with a different request', { operation_id: operationId });
      const recorded = prior.response === null ? null : JSON.parse(prior.response);
      return { status: prior.status, body: replay ? replay(recorded) : recorded };
    }
    const work = (async () => {
      const result = await run();
      store.recordOperation({ scope, operation_id: operationId, fingerprint, status: result.status, response: result.body === null ? null : JSON.stringify(result.record ?? result.body), at: stamp() });
      return result;
    })();
    inflight.set(key, work);
    try { return await work; } finally { inflight.delete(key); }
  }

  // ---------- views ----------
  const tokenView = (t: CallerToken) => ({ id: t.id, name: t.name, state: t.state, created_at: t.created_at, last_used_at: t.last_used_at });
  const incomingView = (c: Call) => ({ id: c.id, direction: c.direction, state: c.state, caller_name: c.caller_name, subject: c.subject, ring_expires_at: c.ring_expires_at });
  const acceptedView = (c: Call) => ({ id: c.id, direction: c.direction, state: c.state, owner_device_id: c.owner_device_id, caller_name: c.caller_name, subject: c.subject, target_binding: c.target_binding, text_channel: textChannel(c.id) });
  const outgoingView = (c: Call) => ({ id: c.id, direction: c.direction, state: c.state, target: { id: c.target_id, label: c.target_label }, target_binding: c.target_binding, text_channel: textChannel(c.id), started_at: c.started_at });
  function callView(c: Call, viewer: Device) {
    const owner = c.owner_device_id === viewer.id;
    const view: Record<string, unknown> = c.direction === 'incoming' ? incomingView(c) : { id: c.id, direction: c.direction, state: c.state, target: { id: c.target_id, label: c.target_label }, started_at: c.started_at };
    if (c.owner_device_id) view.owner_device_id = c.owner_device_id;
    if (owner && c.state !== 'ended') { view.target_binding = c.target_binding; view.text_channel = textChannel(c.id); }
    if (c.state === 'ended') { view.ended_at = c.ended_at; view.end_reason = c.end_reason; }
    return view;
  }

  type SessionTarget = {id: string; label: string; project: string; kind: string; is_default: boolean};
  let sessions = new Map<string, SessionTarget>();
  const catalogRequests = new Map<string, {resolve: (targets: SessionTarget[]) => void; reject: (error: Error) => void; timer: Timer}>();
  async function sessionCatalog(): Promise<SessionTarget[]> {
    if (!connector?.catalog) return [];
    const request = newId('catalog');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { catalogRequests.delete(request); reject(fail('target_unavailable', 'Session list is unavailable')); }, 15000);
      catalogRequests.set(request, {resolve, reject, timer});
      toConnector({type: 'catalog.request', request_id: request});
    });
  }
  // ---------- targets and connector ----------
  function targetAvailable(targetId: string) { return !!connector && (connector.targets.has(targetId) || (connector.catalog && sessions.has(targetId))); }
  async function bindTarget(callId: string, targetId: string): Promise<string> {
    if (!targetAvailable(targetId)) throw fail('target_unavailable', 'no connector serves this target');
    const requestId = newId('bind');
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { pendingBinds.delete(requestId); reject(fail('target_unavailable', 'the connector did not prepare the target in time')); }, 15_000);
      pendingBinds.set(requestId, { resolve, reject, timer });
      if (!toConnector({ type: 'bind.request', request_id: requestId, call_id: callId, target_id: targetId })) {
        clearTimeout(timer); pendingBinds.delete(requestId); reject(fail('target_unavailable', 'the connector is not reachable'));
      }
    });
  }
  async function requireBackend(): Promise<Backend> {
    let backend = activeBackend();
    if (backend.provider !== 'openai' && (!backend.voice || backend.voice === 'default') && backend.settings_address) {
      const catalog = await profiles.voices(backend);
      backend = { ...backend, voice: catalog.voice && catalog.voice !== 'default' ? catalog.voice : catalog.default_voice };
    }
    if (!(await ready(backend))) throw fail('backend_unavailable', 'the active voice backend is not ready');
    return backend;
  }
  function phonePolicy(): { allowed: boolean; reason: string } {
    for (const d of store.activeDevices()) {
      if (d.platform !== 'ios' || d.calls_allowed === null || d.calls_allowed === 1) continue;
      if (d.availability_valid_until && Date.parse(d.availability_valid_until) > now()) return { allowed: false, reason: d.availability_reason ?? 'calls_disabled' };
    }
    return { allowed: true, reason: 'available' };
  }

  // ---------- call lifecycle ----------
  function endCall(callId: string, reason: string, by: string) {
    if (!store.endCall(callId, reason, by, stamp())) return false;
    cloud.end(callId);
    const timer = ringTimers.get(callId); if (timer) { clearTimeout(timer); ringTimers.delete(callId); }
    const ended = event('call.ended', { call_id: callId, reason });
    for (const sockets of deviceSockets.values()) sendTo(sockets, ended);
    const text = textSockets.get(callId);
    sendTo(text, ended);
    for (const ws of text ?? []) { try { ws.close(1000, 'call ended'); } catch { /* closed */ } }
    textSockets.delete(callId);
    toConnector({ type: 'call.ended', call_id: callId, reason });
    for (const [responseId, turn] of liveTurns) if (turn.callId === callId) liveTurns.delete(responseId);
    for (const turn of store.turns(callId)) replies.delete(turn.response_id);
    log({ event: 'call.ended', call_id: callId, reason, by });
    return true;
  }
  function armRing(call: Call) {
    const delay = Math.max(0, Date.parse(call.ring_expires_at!) - now());
    ringTimers.set(call.id, setTimeout(() => { ringTimers.delete(call.id); const c = store.call(call.id); if (c?.state === 'ringing') endCall(call.id, 'no_answer', 'switchboard'); }, delay));
  }
  async function signalIncoming(call: Call) {
    const incoming = event('call.incoming', { call: incomingView(call) });
    const at = stamp();
    for (const d of store.activeDevices()) {
      if (sendTo(deviceSockets.get(d.id), incoming)) store.addSignal(call.id, d.id, 'device_events', 'sent', at);
      if (d.platform === 'ios' && d.push_voip_token && d.push_bundle_id) {
        const payload = { aps: {}, voicestack: { profile: PROFILE_APP, event: 'call.incoming', event_id: incoming.event_id, call_id: call.id, caller_name: call.caller_name, subject: call.subject, ring_expires_at: call.ring_expires_at } };
        const result = await push.send({ environment: d.push_environment ?? 'sandbox', bundle_id: d.push_bundle_id, voip_token: d.push_voip_token, expires_at_ms: Date.parse(call.ring_expires_at!), payload });
        store.addSignal(call.id, d.id, `apns_${push.kind}`, result.ok ? `sent ${result.apns_id}` : `failed ${result.status} ${result.reason ?? ''}`.trim(), stamp());
      }
    }
  }

  async function incomingCall(token: CallerToken, payload: Record<string, unknown>) {
    const operationId = v.operationId(payload);
    const subject = v.subject(payload);
    if (token.state !== 'active') {
      store.addCallRequest(stamp(), token.id, operationId, 'token_revoked', null);
      log({ event: 'call.refused', caller_token_id: token.id, reason: 'token_revoked' });
      throw fail('token_revoked', 'this caller token is revoked', { operation_id: operationId });
    }
    const result = await idempotent(`ctok:${token.id}`, operationId, payload, async () => {
      const target = config.targets.find(t => t.is_default)!;
      const callId = newId('call');
      let laneRef: string, backend: Backend;
      try {
        laneRef = await bindTarget(callId, target.id);
        backend = await requireBackend();
      } catch (error) {
        store.addCallRequest(stamp(), token.id, operationId, error instanceof ApiError ? error.code : 'error', null);
        throw error;
      }
      const startedMs = now();
      const call: Call = {
        id: callId, direction: 'incoming', state: 'ringing', caller_token_id: token.id, caller_name: token.name, subject,
        target_id: target.id, target_label: target.label, target_binding: newId('binding'), lane_ref: laneRef,
        owner_device_id: null, backend_id: backend.id, backend_profile: backend.profile,
        started_at: rfc3339(startedMs), ring_expires_at: rfc3339(startedMs + config.ring_seconds * 1000),
        accepted_at: null, ended_at: null, end_reason: null, ended_by: null,
      };
      store.addCall(call);
      profiles.pin(call, backend);
      store.touchCallerToken(token.id, call.started_at);
      const policy = phonePolicy();
      if (!policy.allowed) {
        // The phone's published policy governs both devices: the call is recorded and declined unsignalled.
        store.addCallRequest(stamp(), token.id, operationId, `declined_${policy.reason}`, callId);
        endCall(callId, policy.reason, 'phone_policy');
        return { status: 200, body: { call: incomingView(store.call(callId)!) } };
      }
      store.addCallRequest(stamp(), token.id, operationId, 'ringing', callId);
      log({ event: 'call.ringing', call_id: callId, caller_token_id: token.id, target_id: target.id, backend: backend.id });
      armRing(call);
      // Speech and target are prepared before the ring (PROTOCOL.md section 2.5); then both routes are signalled.
      await signalIncoming(call);
      return { status: 200, body: { call: incomingView(call) } };
    });
    return result;
  }

  async function outgoingCall(caller: Device, payload: Record<string, unknown>) {
    const operationId = v.operationId(payload);
    const targetId = v.string(payload, 'target_id', { max: 120 });
    return idempotent(`dev:${caller.id}`, operationId, payload, async () => {
      if (targetId.startsWith('session:')) await sessionCatalog();
      const target = config.targets.find(t => t.id === targetId) ?? sessions.get(targetId);
      if (!target) throw fail('validation_error', 'unknown target_id', { operation_id: operationId });
      const callId = newId('call');
      const laneRef = await bindTarget(callId, target.id);
      const backend = await requireBackend();
      const call: Call = {
        id: callId, direction: 'outgoing', state: 'connecting', caller_token_id: null, caller_name: null, subject: null,
        target_id: target.id, target_label: target.label, target_binding: newId('binding'), lane_ref: laneRef,
        owner_device_id: caller.id, backend_id: backend.id, backend_profile: backend.profile,
        started_at: stamp(), ring_expires_at: null, accepted_at: stamp(), ended_at: null, end_reason: null, ended_by: null,
      };
      store.addCall(call);
      profiles.pin(call, backend);
      log({ event: 'call.outgoing', call_id: callId, owner_device_id: caller.id, target_id: target.id, backend: backend.id });
      const response = { call: outgoingView(call), backend: handout(call, caller.id) };
      // The handout's credential is never recorded; a replay issues a fresh one for the same call.
      return { status: 200, body: response, record: { call: response.call } };
    }, recorded => {
      const call = store.call((recorded as { call: { id: string } }).call.id)!;
      return { ...(recorded as object), backend: handout(call, caller.id) };
    });
  }

  function liveCall(id: string): Call {
    const call = store.call(id);
    if (!call) throw new ApiError('call_not_active', 'unknown call', { status: 404 });
    return call;
  }

  // ---------- routes ----------
  async function appRoute(request: Request, path: string, server: Server<SocketData>): Promise<Response | 'upgraded' | undefined> {
    const method = request.method;
    if (path === '/settings/speech' || path === '/settings/speech/preview') {
      const me = device(request);
      if (method === 'GET' && path === '/settings/speech') {
        const p = profiles.active();
        return json(200, { backend_id: p.id, backend_label: p.label || p.id, ...await profiles.voices(p) });
      }
      const payload = v.object(await body(request), ['operation_id', 'voice']);
      const operationId = v.operationId(payload);
      const voice = v.string(payload, 'voice', { max: 80 });
      if (method === 'PUT' && path === '/settings/speech') {
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, action: 'choose-voice' }, async () => {
          const p = profiles.active();
          const catalog = await profiles.voices(p);
          if (!catalog.voices.some(v => v.id === voice)) throw fail('validation_error', 'Choose an available voice');
          const selected = voice === 'default' ? catalog.default_voice : voice;
          profiles.save({ ...profiles.get(p.id), voice: selected });
          return { status: 200, body: { backend_id: p.id, backend_label: p.label || p.id, ...catalog, voice: selected } };
        });
        return json(result.status, result.body);
      }
      if (method === 'POST' && path === '/settings/speech/preview') {
        const p = profiles.active();
        const catalog = await profiles.voices(p);
        if (!catalog.voices.some(v => v.id === voice)) throw fail('validation_error', 'Choose an available voice');
        if (p.provider === 'openai') return cloud.speech(new Request('https://preview.invalid', { method: 'POST', signal: request.signal,
          body: JSON.stringify({model:'local-breeze',voice:'local-default',input:'This is a preview of the selected voice.',response_format:'pcm'}) }), { ...p, voice });
        if (!p.settings_address) throw fail('backend_unavailable', 'Voice preview is unavailable');
        const url = new URL(p.settings_address + '/preview');
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(40000)]),
          headers: {authorization:'Bearer '+signer.management(p,'POST',url.pathname,now()),'content-type':'application/json'}, body: JSON.stringify({voice}) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/pcm')) throw fail('backend_unavailable', 'Voice preview failed');
        return new Response(response.body, {headers:{'content-type':'audio/pcm','cache-control':'no-store'}});
      }
      throw fail('validation_error', 'Unsupported voice settings action');
    }
    const parts = path.split('/').filter(Boolean);

    if (method === 'POST' && path === '/pair') {
      const payload = v.object(await body(request), ['profile', 'pairing_code', 'device']);
      if (payload.profile !== PROFILE_APP) throw fail('profile_unsupported', `profile must be ${PROFILE_APP}`);
      const info = v.object(payload.device, ['installation_id', 'name', 'platform', 'app_version'], 'device');
      const installationId = v.uuid(info, 'installation_id');
      const name = v.string(info, 'name', { max: 80 });
      const platform = v.oneOf(info, 'platform', ['ios', 'macos'] as const);
      const appVersion = v.string(info, 'app_version', { max: 40 });
      const code = v.string(payload, 'pairing_code', { max: 120 });
      const at = stamp();
      if (!store.usePairingCode(code, at)) throw fail('unauthorized', 'pairing code is unknown or already used');
      const id = newId('dev');
      const credential = newSecret('sbd');
      store.addDevice({ id, installation_id: installationId, name, platform, app_version: appVersion, credential_hash: sha256(credential), paired_at: at });
      store.retireInstallation(installationId, id, at);
      log({ event: 'device.paired', device_id: id, platform });
      return json(200, { device_id: id, device_credential: credential, paired_at: at, profile: PROFILE_APP });
    }
    if (method === 'POST' && path === '/pair/ack') {
      const me = device(request, { acknowledged: false });
      const payload = v.object(await body(request), ['operation_id', 'installation_id']);
      const operationId = v.operationId(payload);
      if (v.uuid(payload, 'installation_id') !== me.installation_id) throw fail('validation_error', 'installation_id does not match this pairing', { operation_id: operationId });
      const result = await idempotent(`dev:${me.id}`, operationId, payload, async () => {
        store.acknowledge(me.id, stamp());
        return { status: 200, body: { paired: true, device_id: me.id } };
      });
      return json(result.status, result.body);
    }
    if (method === 'GET' && path === '/me') {
      const me = device(request, { acknowledged: false });
      return json(200, { device_id: me.id, name: me.name, platform: me.platform, app_version: me.app_version, installation_id: me.installation_id, paired_at: me.paired_at, acknowledged: !!me.acknowledged_at, push_registered: !!me.push_voip_token, profile: PROFILE_APP });
    }
    if (method === 'PUT' && path === '/devices/me/push') {
      const me = device(request, { platform: 'ios' });
      const payload = v.object(await body(request), ['operation_id', 'environment', 'bundle_id', 'voip_token']);
      const operationId = v.operationId(payload);
      const environment = v.oneOf(payload, 'environment', ['sandbox', 'production'] as const);
      const bundleId = v.string(payload, 'bundle_id', { max: 200 });
      const voipToken = v.string(payload, 'voip_token', { max: 400 });
      const result = await idempotent(`dev:${me.id}`, operationId, payload, async () => {
        store.setPush(me.id, environment, bundleId, voipToken, stamp());
        return { status: 200, body: { device_id: me.id, push_registered: true, environment } };
      });
      return json(result.status, result.body);
    }
    if (method === 'PUT' && path === '/devices/me/availability') {
      const me = device(request, { platform: 'ios' });
      const payload = v.object(await body(request), ['operation_id', 'calls_allowed', 'reason', 'valid_until']);
      const operationId = v.operationId(payload);
      const allowed = v.boolean(payload, 'calls_allowed');
      const reason = v.oneOf(payload, 'reason', AVAILABILITY_REASONS);
      const validUntil = v.timestamp(payload, 'valid_until');
      if (allowed !== (reason === 'available')) throw fail('validation_error', 'reason must be available exactly when calls_allowed is true', { operation_id: operationId });
      const result = await idempotent(`dev:${me.id}`, operationId, payload, async () => {
        store.setAvailability(me.id, allowed, reason, validUntil, stamp());
        // A restrictive state while a call rings declines it on both devices.
        if (!allowed && Date.parse(validUntil) > now()) for (const call of store.callsInState('ringing')) endCall(call.id, reason, `phone_policy:${me.id}`);
        return { status: 200, body: { calls_allowed: allowed, reason, valid_until: validUntil } };
      });
      return json(result.status, result.body);
    }

    if (parts[0] === 'caller-tokens') {
      const me = device(request);
      if (method === 'POST' && parts.length === 1) {
        const payload = v.object(await body(request), ['operation_id', 'name']);
        const operationId = v.operationId(payload);
        const name = v.string(payload, 'name', { max: 60 }).trim();
        if (!name) throw fail('validation_error', 'name must contain 1 to 60 characters', { operation_id: operationId });
        let issued = '';
        const result = await idempotent(`dev:${me.id}`, operationId, payload, async () => {
          const id = newId('ctok');
          issued = newSecret('sbc');
          store.addCallerToken({ id, name, secret_hash: sha256(issued), created_at: stamp(), created_by_device: me.id });
          log({ event: 'caller_token.created', caller_token_id: id, device_id: me.id });
          const token = tokenView(store.callerToken(id)!);
          // The secret is never recorded; only its hash is stored.
          return { status: 200, body: { token, secret: issued }, record: { token } };
        }, recorded => {
          // A lost creation response is reconciled by reissuing the secret, while it was never used: the undelivered
          // secret's hash is replaced, so no stored state ever holds a secret.
          const id = (recorded as { token: { id: string } }).token.id;
          const token = store.callerToken(id);
          if (!token || token.state !== 'active' || token.last_used_at) throw fail('operation_conflict', 'this token was already used or revoked; its secret is not shown again', { operation_id: operationId });
          const secret = newSecret('sbc');
          store.db.query('UPDATE caller_token SET secret_hash = ? WHERE id = ?').run(sha256(secret), id);
          log({ event: 'caller_token.secret_reissued', caller_token_id: id });
          return { token: tokenView(token), secret };
        });
        return json(result.status, result.body);
      }
      if (method === 'GET' && parts.length === 1) return json(200, { tokens: store.callerTokens().map(tokenView) });
      const id = decodeURIComponent(parts[1] ?? '');
      if (method === 'POST' && parts.length === 3 && parts[2] === 'revoke') {
        const payload = v.object(await body(request), ['operation_id']);
        const operationId = v.operationId(payload);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, id }, async () => {
          if (!store.callerToken(id)) throw new ApiError('validation_error', 'unknown caller token', { status: 404, operation_id: operationId });
          store.revokeCallerToken(id, stamp());
          log({ event: 'caller_token.revoked', caller_token_id: id, device_id: me.id });
          const t = store.callerToken(id)!;
          return { status: 200, body: { id: t.id, name: t.name, state: t.state, revoked_at: t.revoked_at, last_used_at: t.last_used_at } };
        });
        return json(result.status, result.body);
      }
      if (method === 'DELETE' && parts.length === 2) {
        const payload = v.object(await body(request), ['operation_id']);
        const operationId = v.operationId(payload);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, id }, async () => {
          const t = store.callerToken(id);
          if (!t) throw new ApiError('validation_error', 'unknown caller token', { status: 404, operation_id: operationId });
          if (t.state === 'active') throw fail('token_active', 'revoke the token before deleting it', { operation_id: operationId });
          store.deleteCallerToken(id, stamp());
          log({ event: 'caller_token.deleted', caller_token_id: id, device_id: me.id });
          return { status: 204, body: null };
        });
        return json(result.status, null);
      }
    }

    if (method === 'GET' && path === '/targets') {
      device(request);
      const discovered = await sessionCatalog();
      return json(200, { targets: [...config.targets, ...discovered].map(t => ({ ...t, available: targetAvailable(t.id) })) });
    }

    if (method === 'POST' && path === '/calls') {
      const who = principal(request);
      const raw = await body(request);
      if (who.kind === 'caller') {
        const payload = v.object(raw, ['operation_id', 'direction', 'subject']);
        if (payload.direction !== 'incoming') throw fail('forbidden', 'a caller token can only request an incoming call');
        const result = await incomingCall(who.token, payload);
        return json(result.status, result.body);
      }
      if (who.kind !== 'device') throw fail('forbidden', 'device credential or caller token required');
      if (!who.device.acknowledged_at) throw fail('forbidden', 'pairing is not acknowledged');
      const payload = v.object(raw, ['operation_id', 'direction', 'target_id']);
      if (payload.direction !== 'outgoing') throw fail('forbidden', 'a device starts outgoing calls only');
      const result = await outgoingCall(who.device, payload);
      return json(result.status, result.body);
    }

    if (parts[0] === 'calls' && parts.length >= 2) {
      const callId = decodeURIComponent(parts[1]);
      if (parts.length === 3 && parts[2] === 'text') {
        const me = device(request);
        const call = liveCall(callId);
        if (call.owner_device_id !== me.id) throw fail('forbidden', 'only the owning device joins the text channel');
        if (call.state === 'ended' || call.state === 'ringing') throw fail('call_not_active', 'the call is not active');
        if (server.upgrade(request, { data: { kind: 'text', deviceId: me.id, callId } })) return 'upgraded';
        throw fail('validation_error', 'WebSocket upgrade required');
      }
      const me = device(request);
      if (method === 'GET' && parts.length === 2) return json(200, { call: callView(liveCall(callId), me) });
      if (method !== 'POST' || parts.length !== 3) return undefined;
      const action = parts[2];
      if (action === 'accept') {
        const payload = v.object(await body(request), ['operation_id']);
        const operationId = v.operationId(payload);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, callId, action }, async () => {
          const call = liveCall(callId);
          if (call.direction !== 'incoming') throw fail('call_not_active', 'only incoming calls are accepted', { operation_id: operationId });
          if (call.state === 'ringing' && call.ring_expires_at && Date.parse(call.ring_expires_at) <= now()) endCall(call.id, 'no_answer', 'switchboard');
          const current = store.call(callId)!;
          if (current.state === 'ended') throw fail('call_not_active', 'the call has ended', { operation_id: operationId });
          const backend = profiles.forCall(current);
          if (current.state !== 'ringing' || !store.claimCall(callId, me.id, backend.id, backend.profile, stamp())) throw fail('call_taken', 'another device answered', { operation_id: operationId });
          const timer = ringTimers.get(callId); if (timer) { clearTimeout(timer); ringTimers.delete(callId); }
          const won = store.call(callId)!;
          const taken = event('call.taken', { call_id: callId });
          for (const [deviceId, sockets] of deviceSockets) if (deviceId !== me.id) sendTo(sockets, taken);
          toConnector({ type: 'call.accepted', call_id: callId });
          log({ event: 'call.accepted', call_id: callId, owner_device_id: me.id, backend: backend.id });
          const response = { call: acceptedView(won), backend: handout(won, me.id) };
          return { status: 200, body: response, record: { call: response.call } };
        }, recorded => ({ ...(recorded as object), backend: handout(store.call(callId)!, me.id) }));
        return json(result.status, result.body);
      }
      if (action === 'decline') {
        const payload = v.object(await body(request), ['operation_id', 'reason']);
        const operationId = v.operationId(payload);
        const reason = v.oneOf(payload, 'reason', DECLINE_REASONS);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, callId, action }, async () => {
          const call = liveCall(callId);
          if (call.state === 'ended') throw fail('call_not_active', 'the call has ended', { operation_id: operationId });
          if (call.state !== 'ringing') throw fail('call_taken', 'the call was answered', { operation_id: operationId });
          store.addDecline(callId, me.id, reason, stamp());
          if (reason !== 'user') endCall(callId, reason, `decline:${me.id}`);
          else {
            const signalled = new Set(store.signals(callId).filter(s => s.result.startsWith('sent')).map(s => s.device_id));
            const declined = new Set(store.declines(callId).map(d => d.device_id));
            if ([...signalled].every(id => declined.has(id))) endCall(callId, 'user', `decline:${me.id}`);
          }
          return { status: 200, body: { call: callView(store.call(callId)!, me) } };
        });
        return json(result.status, result.body);
      }
      if (action === 'end') {
        const payload = v.object(await body(request), ['operation_id', 'reason']);
        const operationId = v.operationId(payload);
        v.oneOf(payload, 'reason', ['user'] as const);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, callId, action }, async () => {
          const call = liveCall(callId);
          if (call.owner_device_id !== me.id) throw fail('forbidden', 'only the owning device ends the call', { operation_id: operationId });
          if (call.state === 'ended') throw fail('call_not_active', 'the call has ended', { operation_id: operationId });
          endCall(callId, 'user', `device:${me.id}`);
          return { status: 200, body: { call: callView(store.call(callId)!, me) } };
        });
        return json(result.status, result.body);
      }
      if (action === 'backend-handoff') {
        const payload = v.object(await body(request), ['operation_id']);
        const operationId = v.operationId(payload);
        const result = await idempotent(`dev:${me.id}`, operationId, { ...payload, callId, action }, async () => {
          const call = liveCall(callId);
          if (call.state === 'ended' || call.state === 'ringing') throw fail('call_not_active', 'the call is not active', { operation_id: operationId });
          if (call.owner_device_id !== me.id) throw fail('forbidden', 'only the owning device gets a handout', { operation_id: operationId });
          return { status: 200, body: { backend: handout(call, me.id) }, record: { call_id: callId } };
        }, () => ({ backend: handout(store.call(callId)!, me.id) }));
        return json(result.status, result.body);
      }
    }
    return undefined;
  }

  // ---------- text channel ----------
  function textMessage(ws: ServerWebSocket<SocketData> & { data: { kind: 'text' } }, raw: string) {
    const { callId } = ws.data as { callId: string };
    const reply = (message: unknown) => { try { ws.send(JSON.stringify(message)); } catch { /* closed */ } };
    let operationId: string | null = null;
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw fail('validation_error', 'frame must be JSON'); }
      const msg = v.object(parsed, ['type', 'operation_id', 'text', 'delivery'], 'event');
      if (msg.type !== 'turn.submit') throw fail('validation_error', 'unsupported event type');
      operationId = v.operationId(msg);
      const text = v.string(msg, 'text', { max: 8000 });
      if (!text.trim()) throw fail('validation_error', 'text must not be empty', { operation_id: operationId });
      const delivery = v.oneOf(msg, 'delivery', DELIVERY);
      const call = store.call(callId);
      if (!call || call.state === 'ended') throw fail('call_not_active', 'the call has ended', { operation_id: operationId });
      const fingerprint = sha256(canonical({ text, delivery }));
      const prior = store.turn(callId, operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('operation_conflict', 'operation_id was already used with a different turn', { operation_id: operationId });
        reply(acceptedEvent(prior, call));
        // Finished: the recorded outcome again, in the text-channel shape. Still streaming: the rest follows here.
        if (prior.status !== 'in_progress') reply({ type: 'reply.done', response_id: prior.response_id, text: replies.get(prior.response_id) ?? '', status: prior.status });
        return;
      }
      if (!connector) throw fail('target_unavailable', 'the connector is not connected', { operation_id: operationId });
      const effective = delivery === 'steer' && !connector.steer ? 'queue' : delivery;
      const turn: Turn = {
        call_id: callId, operation_id: operationId, fingerprint, response_id: newId('resp'), requested_delivery: delivery, effective_delivery: effective,
        fallback_reason: effective !== delivery ? 'steer_not_supported' : null, status: 'in_progress', text_chars: [...text].length, reply_chars: null, submitted_at: stamp(), done_at: null,
      };
      store.addTurn(turn);
      liveTurns.set(turn.response_id, { callId, operationId, responseId: turn.response_id, sequence: 0, text: '' });
      reply(acceptedEvent(turn, call));
      toConnector({ type: 'turn', call_id: callId, lane_ref: call.lane_ref, target_id: call.target_id, response_id: turn.response_id, operation_id: operationId, text, delivery: effective });
      log({ event: 'turn.accepted', call_id: callId, response_id: turn.response_id, requested: delivery, effective });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : fail('validation_error', 'invalid frame');
      reply({ type: 'error', ...apiError.body(operationId) });
    }
  }
  function acceptedEvent(turn: Turn, call: Call) {
    return { type: 'turn.accepted', operation_id: turn.operation_id, response_id: turn.response_id, requested_delivery: turn.requested_delivery, effective_delivery: turn.effective_delivery, fallback_reason: turn.fallback_reason, target_binding: call.target_binding };
  }

  // ---------- connector stream ----------
  function connectorMessage(ws: ServerWebSocket<SocketData>, raw: string) {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'connector.hello') {
      const previous = connector;
      sessions.clear();
      connector = { ws, id: (ws.data as { connectorId: string }).connectorId, steer: msg.steer === true, catalog: msg.catalog === true, targets: new Set(Array.isArray(msg.targets) ? msg.targets.map(String) : []), version: String(msg.version ?? '') };
      if (previous && previous.ws !== ws) { try { previous.ws.close(4000, 'replaced by a newer connector'); } catch { /* closed */ } }
      ws.send(JSON.stringify({ type: 'connector.ready', targets: [...connector.targets].filter(id => config.targets.some(t => t.id === id)) }));
      log({ event: 'connector.ready', connector_id: connector.id, targets: [...connector.targets], steer: connector.steer });
      return;
    }
    if (!connector || connector.ws !== ws) return;
    if (msg.type === 'catalog.result') {
      const pending = catalogRequests.get(String(msg.request_id));
      if (!pending) return;
      clearTimeout(pending.timer); catalogRequests.delete(String(msg.request_id));
      if (msg.error || !Array.isArray(msg.targets)) { pending.reject(fail('target_unavailable', 'Session list is unavailable')); return; }
      const rows: SessionTarget[] = msg.targets.filter((t: any) => /^session:ses_[A-Za-z0-9]+$/.test(t?.id) && typeof t.label === 'string' && typeof t.project === 'string')
        .map((t: any) => ({id: t.id, label: t.label.slice(0,500), project: t.project.slice(0,2000), kind:'conversation', is_default:false}));
      sessions = new Map(rows.map(t => [t.id,t])); pending.resolve(rows); return;
    }
    if (msg.type === 'bind.result') {
      const pending = pendingBinds.get(String(msg.request_id));
      if (!pending) return;
      clearTimeout(pending.timer); pendingBinds.delete(String(msg.request_id));
      if (msg.ok === true && typeof msg.lane_ref === 'string' && msg.lane_ref) pending.resolve(msg.lane_ref);
      else pending.reject(fail('target_unavailable', 'the target could not be prepared'));
      return;
    }
    if (msg.type === 'reply.delta' || msg.type === 'reply.done') {
      const live = liveTurns.get(String(msg.response_id));
      if (!live) return;
      const sockets = textSockets.get(live.callId);
      if (msg.type === 'reply.delta') {
        if (typeof msg.delta !== 'string' || !msg.delta) return;
        live.sequence += 1; live.text += msg.delta;
        sendTo(sockets, { type: 'reply.delta', response_id: live.responseId, sequence: live.sequence, delta: msg.delta });
        return;
      }
      const status = msg.status === 'completed' ? 'completed' : 'failed';
      const text = typeof msg.text === 'string' ? msg.text : live.text;
      liveTurns.delete(live.responseId);
      replies.set(live.responseId, text);
      store.finishTurn(live.callId, live.operationId, status, [...text].length, stamp());
      sendTo(sockets, { type: 'reply.done', response_id: live.responseId, text, status });
      log({ event: 'reply.done', call_id: live.callId, response_id: live.responseId, status, deltas: live.sequence });
      return;
    }
    if (msg.type === 'call.end') { const call = store.call(String(msg.call_id)); if (call && call.state !== 'ended') endCall(call.id, 'caller', `connector:${connector.id}`); }
  }
  function connectorGone(ws: ServerWebSocket<SocketData>) {
    if (connector?.ws !== ws) return;
    connector = null;
    sessions.clear();
    for (const pending of catalogRequests.values()) { clearTimeout(pending.timer); pending.reject(fail('target_unavailable', 'the connector disconnected')); }
    catalogRequests.clear();
    for (const [id, pending] of pendingBinds) { clearTimeout(pending.timer); pendingBinds.delete(id); pending.reject(fail('target_unavailable', 'the connector disconnected')); }
    for (const live of [...liveTurns.values()]) {
      liveTurns.delete(live.responseId);
      store.finishTurn(live.callId, live.operationId, 'failed', [...live.text].length, stamp());
      sendTo(textSockets.get(live.callId), { type: 'reply.done', response_id: live.responseId, text: live.text, status: 'failed' });
    }
    log({ event: 'connector.gone' });
  }

  // ---------- server ----------
  // Calls that were live when Switchboard last stopped cannot continue: their sockets are gone.
  for (const call of store.callsInState('ringing', 'connecting', 'active')) store.endCall(call.id, 'switchboard_restart', 'switchboard', stamp());

  const server = Bun.serve<SocketData, never>({
    hostname: config.listen.host,
    port: config.listen.port,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/settings' || url.pathname === '/settings/' || url.pathname === '/settings/app.js') {
          return new Response(url.pathname.endsWith('.js') ? settingsScript : settingsPage, { headers: {
            'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          } });
        }
        const settingsResponse = await settings(request, url.pathname);
        if (settingsResponse) return settingsResponse;
        const media = url.pathname.startsWith(prefix + '/voice/') && /^\/voice\/([^/]+)\/(speech|realtime)$/.exec(url.pathname.slice(prefix.length));
        if (media) {
          const backend = cloud.authorize(request, media[1]);
          if (media[2] === 'speech' && request.method === 'POST') return cloud.speech(request, backend);
          if (media[2] === 'realtime' && server.upgrade(request, { data: { kind: 'cloud', connection: { callId: media[1], backend, pending: [], bytes: 0 } } })) return undefined;
          throw fail('validation_error', 'Invalid cloud speech request');
        }
        if (url.pathname === '/health') return json(200, { status: 'ok' });
        if (url.pathname === '/connector/v1/stream') {
          const who = principal(request);
          if (who.kind !== 'connector') throw fail('forbidden', 'connector credential required');
          if (server.upgrade(request, { data: { kind: 'connector', connectorId: who.id } })) return undefined;
          throw fail('validation_error', 'WebSocket upgrade required');
        }
        if (url.pathname === `${prefix}/device/events`) {
          const me = device(request);
          if (server.upgrade(request, { data: { kind: 'device', deviceId: me.id } })) return undefined;
          throw fail('validation_error', 'WebSocket upgrade required');
        }
        if (url.pathname.startsWith(`${prefix}/`)) {
          const response = await appRoute(request, url.pathname.slice(prefix.length), server);
          if (response === 'upgraded') return undefined;
          if (response !== undefined) return response;
        }
        return json(404, fail('validation_error', 'unknown route').body());
      } catch (error) {
        if (error instanceof ApiError) return json(error.status, error.body(requestOperation(request)));
        log({ event: 'error', path: url.pathname, error: String(error).slice(0, 300) });
        return json(500, { error: { code: 'internal_error', message: 'internal error', retryable: true, operation_id: null } });
      }
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        if (data.kind === 'cloud') { cloud.open(data.connection, ws); return; }
        if (data.kind === 'device') {
          if (!deviceSockets.has(data.deviceId)) deviceSockets.set(data.deviceId, new Set());
          deviceSockets.get(data.deviceId)!.add(ws);
          ws.send(JSON.stringify(event('device.ready', { profile: PROFILE_APP })));
          // A Mac that opens while a call rings is shown that call.
          for (const call of store.callsInState('ringing')) {
            const declined = store.declines(call.id).some(d => d.device_id === data.deviceId);
            if (!declined) { ws.send(JSON.stringify(event('call.incoming', { call: incomingView(call) }))); store.addSignal(call.id, data.deviceId, 'device_events', 'sent', stamp()); }
          }
        } else if (data.kind === 'text') {
          const call = store.call(data.callId);
          if (!call || call.state === 'ended') { ws.close(1000, 'call ended'); return; }
          if (!textSockets.has(data.callId)) textSockets.set(data.callId, new Set());
          textSockets.get(data.callId)!.add(ws);
          if (call.state === 'connecting') store.setCallState(call.id, 'active');
          ws.send(JSON.stringify(event('call.ready', { call_id: call.id, target_binding: call.target_binding })));
        }
      },
      message(ws, message) {
        const raw = typeof message === 'string' ? message : Buffer.from(message).toString();
        if (ws.data.kind === 'cloud') cloud.message(ws.data.connection, raw);
        else if (ws.data.kind === 'text') textMessage(ws as never, raw);
        else if (ws.data.kind === 'connector') connectorMessage(ws, raw);
        // Device events are server-to-device only.
      },
      close(ws) {
        const data = ws.data;
        if (data.kind === 'cloud') cloud.close(data.connection);
        else if (data.kind === 'device') deviceSockets.get(data.deviceId)?.delete(ws);
        else if (data.kind === 'text') textSockets.get(data.callId)?.delete(ws);
        else connectorGone(ws);
      },
    },
  });

  log({ event: 'listening', url: `http://${server.hostname}:${server.port}`, public_base: config.public_base, push: push.kind });

  return {
    server,
    store,
    signer,
    profiles,
    config,
    url: `http://${server.hostname}:${server.port}`,
    /** Administrative actions; the CLI runs these against the same database. */
    admin: {
      pairingCode(code = newPairingCode()) { store.addPairingCode(code, stamp()); return code; },
      connectorCredential(name: string) { const id = newId('conn'); const secret = newSecret('sbk'); store.addConnectorCredential(id, name, secret, stamp()); return { id, secret }; },
      useBackend(id: string) { profiles.select(id); },
      activeBackend,
    },
    connected: () => connector !== null,
    stop() {
      for (const timer of ringTimers.values()) clearTimeout(timer);
      for (const pending of catalogRequests.values()) { clearTimeout(pending.timer); pending.reject(fail('target_unavailable', 'server stopping')); }
      catalogRequests.clear();
      cloud.end();
      server.stop(true);
      store.close();
    },
  };
}
