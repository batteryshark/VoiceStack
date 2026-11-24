#!/usr/bin/env bun
// APNs stub: accepts the provider request Switchboard's push path makes (POST /3/device/<token>) and hands the
// payload to a stub device registered for that token. It checks what real APNs requires of a VoIP push
// (apns-push-type voip, apns-topic <bundle>.voip, priority 10, a JSON payload under 5 KB) and answers as APNs
// does: 200 with apns-id, 400 {"reason": ...} or 410 Unregistered. No request ever leaves the host.
import type { Server } from 'bun';

export type StubPush = { token: string; headers: Record<string, string>; payload: Record<string, unknown>; at: string };

export class ApnsStub {
  readonly received: StubPush[] = [];
  private devices = new Map<string, (push: StubPush) => void | Promise<void>>();
  readonly server: Server<undefined>;
  constructor(port = 0, private readonly journal?: (push: StubPush) => void) {
    this.server = Bun.serve({ hostname: '127.0.0.1', port, fetch: request => this.handle(request) });
  }
  get url() { return `http://127.0.0.1:${this.server.port}`; }
  /** A stub device answers pushes for its VoIP token. */
  register(token: string, onPush: (push: StubPush) => void | Promise<void>) { this.devices.set(token, onPush); }
  stop() { this.server.stop(true); }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/3\/device\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || !match) return Response.json({ reason: 'BadPath' }, { status: 404 });
    const headers = Object.fromEntries(request.headers.entries());
    const fault = (reason: string, status = 400) => Response.json({ reason }, { status });
    if (headers['apns-push-type'] !== 'voip') return fault('InvalidPushType');
    if (!headers['apns-topic']?.endsWith('.voip')) return fault('TopicDisallowed');
    if (headers['apns-priority'] !== '10') return fault('BadPriority');
    if (!/^\d+$/.test(headers['apns-expiration'] ?? '')) return fault('BadExpirationDate');
    const text = await request.text();
    if (text.length > 5120) return fault('PayloadTooLarge', 413);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(text); } catch { return fault('PayloadEmpty'); }
    if (!payload.aps || typeof payload.aps !== 'object') return fault('MissingAps');
    const token = decodeURIComponent(match[1]);
    const device = this.devices.get(token);
    if (!device) return fault('Unregistered', 410);
    const push: StubPush = { token, headers, payload, at: new Date().toISOString() };
    this.received.push(push);
    this.journal?.(push);
    queueMicrotask(() => { void device(push); });
    return new Response(null, { status: 200, headers: { 'apns-id': headers['apns-id'] ?? crypto.randomUUID() } });
  }
}
