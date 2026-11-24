// Stub VoiceStack devices for tests and demos: they speak voicestack-app/1 to the real Switchboard exactly as the
// fixtures show. The iPhone stub receives its ring through the APNs stub; the Mac stub through device events.
import { randomUUID } from 'node:crypto';
import type { ApnsStub, StubPush } from './apns-stub.ts';

export type Paired = { device_id: string; device_credential: string };

export class StubDevice {
  credential = '';
  deviceId = '';
  readonly events: Record<string, unknown>[] = [];
  readonly rings: { via: 'apns' | 'device_events'; call_id: string; caller_name: string; subject: string; reconciled?: unknown }[] = [];
  private socket: WebSocket | null = null;
  constructor(readonly base: string, readonly platform: 'ios' | 'macos', readonly name: string, readonly installationId: string = randomUUID()) {}

  async request(method: string, path: string, body?: unknown, credential = this.credential) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async pair(code: string, request?: Record<string, unknown>) {
    const body = request ?? { profile: 'voicestack-app/1', pairing_code: code, device: { installation_id: this.installationId, name: this.name, platform: this.platform, app_version: '1.0' } };
    const paired = await this.request('POST', '/pair', body, '');
    if (paired.status !== 200) throw new Error(`pair failed: ${JSON.stringify(paired.body)}`);
    this.credential = paired.body.device_credential; this.deviceId = paired.body.device_id;
    return paired;
  }
  async ack(operationId = randomUUID()) { return this.request('POST', '/pair/ack', { operation_id: operationId, installation_id: this.installationId }); }

  /** iPhone: register a VoIP token with Switchboard and answer pushes for it at the APNs stub. */
  async registerPush(apns: ApnsStub, voipToken: string, bundleId = 'fixture.voicestack', operationId = randomUUID()) {
    apns.register(voipToken, push => this.onPush(push));
    return this.request('PUT', '/devices/me/push', { operation_id: operationId, environment: 'sandbox', bundle_id: bundleId, voip_token: voipToken });
  }
  private async onPush(push: StubPush) {
    const vs = push.payload.voicestack as Record<string, string>;
    // Report the call (CallKit would show "caller_name · subject"), then reconcile with Switchboard; never answer.
    const reconciled = await this.request('GET', `/calls/${encodeURIComponent(vs.call_id)}`);
    this.rings.push({ via: 'apns', call_id: vs.call_id, caller_name: vs.caller_name, subject: vs.subject, reconciled: reconciled.body });
  }

  /** Mac: open the device-event WebSocket. Resolves on device.ready. */
  async openEvents(): Promise<Record<string, unknown>> {
    const url = `${this.base.replace(/^http/, 'ws')}/device/events`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.credential}` } } as unknown as string[]);
    this.socket = ws;
    return await new Promise((resolve, reject) => {
      ws.onmessage = message => {
        const event = JSON.parse(String(message.data));
        this.events.push(event);
        if (event.type === 'device.ready') resolve(event);
        if (event.type === 'call.incoming') this.rings.push({ via: 'device_events', call_id: event.call.id, caller_name: event.call.caller_name, subject: event.call.subject });
      };
      ws.onerror = () => reject(new Error('device events failed'));
    });
  }
  closeEvents() { this.socket?.close(); }

  async waitFor(predicate: () => boolean, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(10); }
  }
}

/** The owning app's side of the text channel (PROTOCOL.md section 3). */
export class TextChannel {
  readonly frames: Record<string, unknown>[] = [];
  private ws!: WebSocket;
  static async connect(httpBase: string, textChannelUrl: string, credential: string) {
    // The handout names the public wss URL; tests reach the same path on the loopback listener.
    const path = new URL(textChannelUrl).pathname;
    const origin = new URL(httpBase).origin.replace(/^http/, 'ws');
    const channel = new TextChannel();
    channel.ws = new WebSocket(`${origin}${path}`, { headers: { authorization: `Bearer ${credential}` } } as unknown as string[]);
    channel.ws.onmessage = message => channel.frames.push(JSON.parse(String(message.data)));
    await new Promise<void>((resolve, reject) => { channel.ws.onopen = () => resolve(); channel.ws.onerror = () => reject(new Error('text channel failed')); });
    return channel;
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  close() { this.ws.close(); }
  async waitFor(predicate: (frames: Record<string, unknown>[]) => boolean, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (!predicate(this.frames)) { if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(this.frames)}`); await Bun.sleep(10); }
  }
}
