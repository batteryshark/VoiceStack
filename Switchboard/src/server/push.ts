import type { PushConfig } from './config.ts';
import { randomUUID } from '../common/util.ts';

/**
 * The VoIP push path. It speaks the APNs provider request shape (POST /3/device/<token>, apns-push-type voip,
 * apns-topic <bundle>.voip, priority 10, expiration at the ring's end) so the real sender only changes the
 * transport: HTTP/2 to api[.sandbox].push.apple.com with a provider JWT. Until Apple provider
 * credentials are wired in there is only the stub transport (src/stubs/apns-stub.ts); no real APNs request is ever made.
 */
export type VoipPush = {
  environment: string;
  bundle_id: string;
  voip_token: string;
  expires_at_ms: number;
  payload: Record<string, unknown>;
};

export type PushResult = { ok: boolean; status: number; apns_id: string; reason?: string };

export interface PushSender {
  readonly kind: string;
  send(push: VoipPush): Promise<PushResult>;
}

export class StubApnsSender implements PushSender {
  readonly kind = 'stub';
  constructor(private readonly baseUrl: string) {}
  async send(push: VoipPush): Promise<PushResult> {
    const apnsId = randomUUID();
    try {
      const response = await fetch(`${this.baseUrl}/3/device/${encodeURIComponent(push.voip_token)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'apns-push-type': 'voip',
          'apns-topic': `${push.bundle_id}.voip`,
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(push.expires_at_ms / 1000)),
          'apns-id': apnsId,
          // The stub says which environment the device registered for; real APNs picks a host instead.
          'x-stub-apns-environment': push.environment,
        },
        body: JSON.stringify(push.payload),
        signal: AbortSignal.timeout(5000),
      });
      const reason = response.ok ? undefined : ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? 'unknown';
      return { ok: response.ok, status: response.status, apns_id: response.headers.get('apns-id') ?? apnsId, reason };
    } catch (error) {
      return { ok: false, status: 0, apns_id: apnsId, reason: String(error).slice(0, 120) };
    }
  }
}

export class NoPushSender implements PushSender {
  readonly kind = 'off';
  async send(): Promise<PushResult> { return { ok: false, status: 0, apns_id: '', reason: 'push disabled' }; }
}

export function pushSender(config: PushConfig): PushSender {
  return config.kind === 'stub' ? new StubApnsSender(config.base_url) : new NoPushSender();
}
