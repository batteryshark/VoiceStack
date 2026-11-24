// The fixtures are the contract verbatim, and the matcher really fails on contract breaks.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT, FIXTURES, NAMES, extract } from '../scripts/extract-fixtures.ts';
import { Conformance, fixture } from './conform.ts';

test('every JSON example in PROTOCOL.md sections 2 and 3 is a fixture, byte for byte', () => {
  const blocks = extract(readFileSync(CONTRACT, 'utf8'));
  expect(blocks).toHaveLength(32);
  for (const block of blocks) expect(readFileSync(join(FIXTURES, `${block.name}.json`), 'utf8')).toBe(JSON.stringify(block.value, null, 2) + '\n');
  expect(readdirSync(FIXTURES).sort()).toEqual(NAMES.map(n => `${n}.json`).sort());
});

test('the matcher rejects missing, extra, mistyped and changed fields, and inconsistent ids', () => {
  const good = fixture('incoming-call.response');
  const mismatches = (actual: unknown, name = 'incoming-call.response') => { const c = new Conformance(); c.check(name, actual); return c.problems; };
  expect(mismatches({ call: { ...good.call, id: 'call_abc123' } })).toEqual([]);
  const { subject, ...missing } = good.call;
  expect(mismatches({ call: missing })[0]).toContain('subject: missing');
  expect(mismatches({ call: { ...good.call, id: 'call_abc123', extra: 1 } })[0]).toContain('extra: not in the contract');
  expect(mismatches({ call: { ...good.call, id: 'call_abc123', state: 'connecting' } })[0]).toContain('expected "ringing"');
  expect(mismatches({ call: { ...good.call, id: 'call_abc123', ring_expires_at: 12 } })[0]).toContain('expected string');
  expect(mismatches({ call: { ...good.call, id: 'dev_abc123' } })[0]).toContain('expected a call_ id');
  expect(mismatches({ call: { ...good.call, id: 'call_abc123', ring_expires_at: 'tomorrow' } })[0]).toContain('RFC 3339');
  const c = new Conformance();
  c.check('incoming-call.response', { call: { ...good.call, id: 'call_one111' } });
  c.check('call-incoming.event', { ...fixture('call-incoming.event'), event_id: 'evt_x1y2z3', call: { ...fixture('call-incoming.event').call, id: 'call_two222' } });
  expect(c.problems[0]).toContain('call_fixture_incoming was call_one111');
  const urls = new Conformance();
  urls.ids.set('call_fixture_incoming', 'call_real1234');
  urls.check('accept.response', { ...fixture('accept.response'), call: { ...fixture('accept.response').call, id: 'call_real1234', owner_device_id: 'dev_m1234', target_binding: 'binding_b1234' } });
  expect(urls.problems.join('\n')).toContain('/calls/call_real1234/text');
});
