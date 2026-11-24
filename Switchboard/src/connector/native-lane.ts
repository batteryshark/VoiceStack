import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Lane, LaneTurn } from './lanes.ts';

export type NativeLaneConfig = {
  kind: 'native';
  /** Path to a JSON file naming the session server: { base, runtimePassword, defaultSession }. Read on every use, so a moved default session is noticed. */
  instance: string;
  /** Target id to a session id, or 'default' for the instance file's current defaultSession. */
  targets: Record<string, string>;
  prefix?: string;
  timeout_ms?: number;
};
type Message = { id: string; type: string; text?: string; finish?: string;
  time?: { completed?: number }; content?: { type: string; text?: string }[] };

export class NativeLane implements Lane {
  readonly steer = false;
  constructor(private readonly config: NativeLaneConfig) {}
  targets() { return Object.keys(this.config.targets); }
  private instance() {
    return JSON.parse(readFileSync(this.config.instance, 'utf8')) as {
      base: string; runtimePassword: string; defaultSession: string;
    };
  }
  private target(target: string) {
    if (/^session:ses_[A-Za-z0-9]+$/.test(target)) return target.slice(8);
    const selected = this.config.targets[target];
    if (!selected) throw new Error(`no native session configured for ${target}`);
    return selected === 'default' ? this.instance().defaultSession : selected;
  }
  private async request(path: string, body?: unknown, timeout = 15_000, allowMissing = false): Promise<any> {
    const instance = this.instance();
    const response = await fetch(instance.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + instance.runtimePassword).toString('base64'),
        'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`native ${path.split('/').slice(0, 3).join('/')} answered ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  async catalog() {
    const result: {id: string; label: string; project: string}[] = [];
    const defaultSession = this.instance().defaultSession;
    let path = '/api/session?limit=100';
    const seen = new Set<string>();
    for (;;) {
      const page = await this.request(path);
      for (const session of page.data ?? []) {
        if (session.id === defaultSession || session.time?.archived || !/^ses_[A-Za-z0-9]+$/.test(session.id)) continue;
        result.push({ id: 'session:' + session.id, label: session.title || 'Untitled session',
          project: session.location?.directory || session.directory || session.projectID || 'No project' });
      }
      const next = page.cursor?.next;
      if (!next || seen.has(next)) break;
      seen.add(next); path = '/api/session?limit=100&cursor=' + encodeURIComponent(next);
    }
    return result;
  }
  async resolve(target: string): Promise<string> {
    const session = this.target(target);
    const current = await this.request('/api/session/' + encodeURIComponent(session));
    if ((current.data ?? current).time?.archived) throw new Error('session is archived');
    return JSON.stringify({ target, session });
  }
  async deliver(laneRef: string, turn: LaneTurn, onDelta: (delta: string) => void): Promise<string> {
    const pin = JSON.parse(laneRef) as { target: string; session: string };
    if (this.target(pin.target) !== pin.session) throw new Error('the pinned conversation has been replaced; reconnect the call');
    const base = '/api/session/' + encodeURIComponent(pin.session);
    const id = 'msg_' + createHash('sha256').update('switchboard:' + turn.call_id + ':' + turn.operation_id).digest('hex').slice(0, 32);
    const text = (this.config.prefix ?? '[voice] ') + turn.text;
    const inbox = (await this.request(base + '/inbox')).data as Message[];
    const existing = inbox.find(m => m.id === id)
      ?? (await this.request(base + '/message/' + id, undefined, 15_000, true))?.data;
    if (existing && existing.text !== text) throw new Error('voice operation id already has different text');
    if (!existing) await this.request(base + '/prompt', { id, text, delivery: 'queue', resume: true,
      metadata: { source: 'switchboard', call: turn.call_id, operation: turn.operation_id } });
    await this.request('/api/experimental/session/' + encodeURIComponent(pin.session) + '/wait', {}, this.config.timeout_ms ?? 600_000);
    const messages = await this.messagesThrough(base, id);
    const start = messages.findIndex(m => m.id === id);
    if (start < 0) throw new Error('voice input has not reached session history');
    const after = messages.slice(start + 1);
    const next = after.findIndex(m => m.type === 'user' || m.type === 'synthetic');
    const reply = (next < 0 ? after : after.slice(0, next)).filter(m => m.type === 'assistant'
      && m.time?.completed && m.finish !== 'tool-calls').at(-1);
    const spoken = reply?.content?.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n').trim();
    if (!spoken) throw new Error('no completed reply to this voice input');
    onDelta(spoken);
    return spoken;
  }
  async ended(_laneRef: string, _callId: string, _reason: string): Promise<void> {
    // Switchboard records call cleanup. Hang-ups are not conversation messages.
  }
  private async messagesThrough(base: string, id: string): Promise<Message[]> {
    const messages: Message[] = [];
    let path = base + '/message?limit=100&order=desc';
    for (;;) {
      const page = await this.request(path);
      messages.push(...page.data);
      if (page.data.some((m: Message) => m.id === id) || !page.cursor?.next) break;
      path = base + '/message?limit=100&cursor=' + encodeURIComponent(page.cursor.next);
    }
    return messages.reverse();
  }
}
