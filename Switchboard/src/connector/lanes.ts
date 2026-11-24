import { NativeLane, type NativeLaneConfig } from './native-lane.ts';

/** A turn the connector delivers into the pinned conversation. */
export type LaneTurn = { call_id: string; operation_id: string; text: string; delivery: 'steer' | 'queue' };

/**
 * Where calls land. resolve() pins a target to one conversation at call start and returns an opaque
 * lane reference; deliver() writes one turn into exactly that conversation and streams the speakable reply.
 */
export interface Lane {
  readonly steer: boolean;
  targets(): string[];
  catalog?(): Promise<{ id: string; label: string; project: string }[]>;
  resolve(targetId: string, callId: string): Promise<string>;
  deliver(laneRef: string, turn: LaneTurn, onDelta: (delta: string) => void): Promise<string>;
  ended?(laneRef: string, callId: string, reason: string): Promise<void>;
}

/** A scripted lane for tests and demos: fixed replies, optional pointer change. */
export class ScriptedLane implements Lane {
  readonly delivered: { laneRef: string; turn: LaneTurn }[] = [];
  pointer: Record<string, string>;
  constructor(readonly steer: boolean, private readonly replies: (turn: LaneTurn, laneRef: string) => string[], pointer: Record<string, string> = { target_main: 'conversation-1' }) {
    this.pointer = { ...pointer };
  }
  targets() { return Object.keys(this.pointer); }
  async resolve(targetId: string) { return JSON.stringify({ target: targetId, conversation: this.pointer[targetId] }); }
  async deliver(laneRef: string, turn: LaneTurn, onDelta: (delta: string) => void) {
    this.delivered.push({ laneRef, turn });
    const deltas = this.replies(turn, laneRef);
    for (const delta of deltas) { onDelta(delta); await Bun.sleep(1); }
    return deltas.join('');
  }
}

export type LaneConfig = NativeLaneConfig;

export function laneFromConfig(config: LaneConfig): Lane {
  if (config.kind === 'native') return new NativeLane(config);
  throw new Error(`unknown lane kind ${(config as { kind: string }).kind}`);
}
