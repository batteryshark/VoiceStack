// Extracts every JSON example in sections 2 and 3 of ../Docs/PROTOCOL.md into test/fixtures/contract/.
// The fixtures are the frozen contract verbatim; test/fixtures.test.ts fails if a fixture drifts from the document.
//   bun scripts/extract-fixtures.ts          write the fixtures
//   bun scripts/extract-fixtures.ts --check  exit 1 if any fixture differs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
export const CONTRACT = join(root, '../Docs/PROTOCOL.md');
export const FIXTURES = join(root, 'test/fixtures/contract');

/** Fixture names in document order, one per JSON block in sections 2 and 3. */
export const NAMES = [
  'error-envelope', 'pair.request', 'pair.response', 'pair-ack.request', 'pair-ack.response',
  'push-register.request', 'availability.request', 'caller-token-create.request', 'caller-token-create.response',
  'caller-token-list.response', 'caller-token-revoke.request', 'caller-token-revoke.response', 'targets.response',
  'outgoing-call.request', 'outgoing-call.response', 'incoming-call.request', 'incoming-call.response',
  'device-ready.event', 'call-incoming.event', 'incoming-apns.payload', 'accept.request', 'accept.response',
  'call-taken.event', 'decline.request', 'end.request', 'call-ended.event', 'text-call-ready.event',
  'text-turn-submit.client', 'text-turn-accepted.event', 'text-reply-delta-1.event', 'text-reply-delta-2.event',
  'text-reply-done.event',
] as const;

export function extract(markdown: string) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.startsWith('## 2. '));
  const end = lines.findIndex(line => line.startsWith('## 4. '));
  if (start < 0 || end < 0) throw new Error('sections 2 and 3 not found');
  const blocks: { line: number; value: unknown }[] = [];
  for (let i = start; i < end; i++) {
    if (lines[i].trim() !== '```json') continue;
    let j = i + 1;
    while (lines[j].trim() !== '```') j++;
    blocks.push({ line: i + 2, value: JSON.parse(lines.slice(i + 1, j).join('\n')) });
    i = j;
  }
  if (blocks.length !== NAMES.length) throw new Error(`expected ${NAMES.length} JSON blocks in sections 2-3, found ${blocks.length}`);
  return blocks.map((block, index) => ({ name: NAMES[index], ...block }));
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  mkdirSync(FIXTURES, { recursive: true });
  let differ = 0;
  for (const block of extract(readFileSync(CONTRACT, 'utf8'))) {
    const path = join(FIXTURES, `${block.name}.json`);
    const text = JSON.stringify(block.value, null, 2) + '\n';
    if (check) { if (!existsSync(path) || readFileSync(path, 'utf8') !== text) { differ++; console.error(`differs: ${block.name} (PROTOCOL.md line ${block.line})`); } }
    else writeFileSync(path, text);
  }
  if (check && differ) process.exit(1);
  console.log(check ? 'fixtures match the contract' : `wrote ${NAMES.length} fixtures to ${FIXTURES}`);
}
