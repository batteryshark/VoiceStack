import { expect, test } from 'bun:test';
import { Relay } from '../src/connector/relay.ts';

test('relay retains the call-ended signal after pending turns without cancelling work', async () => {
  const events: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const relay = new Relay({ switchboard: 'http://unused', credential: () => 'fixture', log: () => {},
    lane: { steer: false, targets: () => ['main'], resolve: async () => 'pinned',
      deliver: async () => { events.push('working'); await pending; events.push('finished'); return 'reply'; },
      ended: async (pin, id, reason) => { expect([pin, id, reason]).toEqual(['pinned', 'call', 'user']); events.push('ended'); } } });
  const receive = (frame: object) => (relay as any).handle(JSON.stringify(frame));
  await receive({ type: 'bind.request', call_id: 'call', target_id: 'main' });
  await receive({ type: 'turn', call_id: 'call', lane_ref: 'pinned', text: 'hello' });
  await receive({ type: 'call.ended', call_id: 'call', reason: 'user' });
  await receive({ type: 'call.ended', call_id: 'call', reason: 'user' });
  expect(events).toEqual(['working']);
  finish();
  await Bun.sleep(10);
  expect(events).toEqual(['working', 'finished', 'ended']);
});
