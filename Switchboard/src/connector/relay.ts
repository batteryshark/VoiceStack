import type { Lane } from './lanes.ts';

/**
 * The connector's live link to Switchboard (docs/connector-protocol.md). It prepares targets when Switchboard
 * asks (bind.request), delivers each call's turns into the pinned lane one at a time, and streams the reply back.
 */
export type RelayOptions = {
  /** Switchboard's loopback base, e.g. http://127.0.0.1:47860 */
  switchboard: string;
  credential: () => string;
  lane: Lane;
  log?: (event: Record<string, unknown>) => void;
  reconnect?: boolean;
};

export class Relay {
  private ws: WebSocket | null = null;
  private queues = new Map<string, Promise<void>>();
  private calls = new Map<string, string>();
  private stopped = false;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  constructor(private readonly options: RelayOptions) {
    this.ready = new Promise(resolve => { this.readyResolve = resolve; });
  }
  private log(event: Record<string, unknown>) { (this.options.log ?? (e => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }))))(event); }

  start() {
    const url = this.options.switchboard.replace(/^http/, 'ws') + '/connector/v1/stream';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.options.credential()}` } } as unknown as string[]);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connector.hello', version: 'switchboard-connector/0.1', steer: this.options.lane.steer, catalog: !!this.options.lane.catalog, targets: this.options.lane.targets() }));
    ws.onmessage = message => this.handle(String(message.data));
    ws.onclose = event => {
      this.log({ event: 'relay.closed', code: event.code });
      if (!this.stopped && this.options.reconnect !== false) setTimeout(() => this.start(), 2000);
    };
    ws.onerror = () => { /* onclose follows */ };
    return this;
  }
  stop() { this.stopped = true; this.ws?.close(); }
  private send(message: unknown) { this.ws?.send(JSON.stringify(message)); }

  private async handle(raw: string) {
    const msg = JSON.parse(raw) as Record<string, string>;
    if (msg.type === 'connector.ready') { this.log({ event: 'relay.ready', targets: msg.targets }); this.readyResolve?.(); return; }
    if (msg.type === 'catalog.request') {
      try { this.send({ type: 'catalog.result', request_id: msg.request_id, targets: await this.options.lane.catalog?.() ?? [] }); }
      catch { this.send({ type: 'catalog.result', request_id: msg.request_id, error: true }); }
      return;
    }
    if (msg.type === 'bind.request') {
      try {
        const laneRef = await this.options.lane.resolve(msg.target_id, msg.call_id);
        this.calls.set(msg.call_id, laneRef);
        this.send({ type: 'bind.result', request_id: msg.request_id, ok: true, lane_ref: laneRef });
        this.log({ event: 'relay.bound', call_id: msg.call_id, target_id: msg.target_id });
      } catch (error) {
        this.send({ type: 'bind.result', request_id: msg.request_id, ok: false, reason: String(error).slice(0, 200) });
        this.log({ event: 'relay.bind_failed', call_id: msg.call_id, error: String(error).slice(0, 200) });
      }
      return;
    }
    if (msg.type === 'turn') {
      this.calls.set(msg.call_id, msg.lane_ref);
      // One call's turns reach its lane in order; Queue is the connector's natural delivery.
      const previous = this.queues.get(msg.call_id) ?? Promise.resolve();
      const next = previous.then(() => this.deliver(msg));
      this.queues.set(msg.call_id, next.catch(() => undefined));
      return;
    }
    if (msg.type === 'call.ended') {
      const laneRef = this.calls.get(msg.call_id);
      const pending = this.queues.get(msg.call_id) ?? Promise.resolve();
      this.calls.delete(msg.call_id);
      this.queues.delete(msg.call_id);
      if (laneRef && this.options.lane.ended) {
        // Preserve turn order; hanging up does not cancel the agent's work.
        void pending.then(() => this.options.lane.ended!(laneRef, msg.call_id, msg.reason))
          .catch(error => this.log({ event: 'relay.call_end_failed', call_id: msg.call_id, error: String(error).slice(0, 200) }));
      }
      this.log({ event: 'relay.call_ended', call_id: msg.call_id, reason: msg.reason });
    }
  }

  private async deliver(msg: Record<string, string>) {
    try {
      const text = await this.options.lane.deliver(msg.lane_ref, { call_id: msg.call_id, operation_id: msg.operation_id, text: msg.text, delivery: msg.delivery as 'steer' | 'queue' },
        delta => this.send({ type: 'reply.delta', response_id: msg.response_id, delta }));
      this.send({ type: 'reply.done', response_id: msg.response_id, status: 'completed', text });
      this.log({ event: 'relay.turn_done', call_id: msg.call_id, response_id: msg.response_id });
    } catch (error) {
      this.send({ type: 'reply.done', response_id: msg.response_id, status: 'failed' });
      this.log({ event: 'relay.turn_failed', call_id: msg.call_id, response_id: msg.response_id, error: String(error).slice(0, 300) });
    }
  }
}
