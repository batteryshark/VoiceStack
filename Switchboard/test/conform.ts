import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RFC3339 } from '../src/common/util.ts';

export const FIXTURE_DIR = join(import.meta.dir, 'fixtures/contract');
export function fixture(name: string): any { return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')); }

/**
 * Checks a real Switchboard message against a frozen fixture:
 * - the same keys at every level (no missing field, no extra field) and the same JSON types;
 * - contract constants (states, directions, profiles, modes, names, subjects, codes, booleans, numbers) equal;
 * - generated values (fixture ids such as call_fixture_incoming, fixture- secrets, timestamps) match their kind:
 *   an id keeps its prefix, a timestamp is RFC 3339 UTC, a secret is a non-empty string;
 * - a generated id maps to one real value across a whole scenario, and URLs containing ids are compared after
 *   substituting the real ids, so e.g. text_channel must name the real call.
 */
export class Conformance {
  readonly ids = new Map<string, string>();
  readonly problems: string[] = [];

  check(name: string, actual: unknown, expected: unknown = fixture(name)) {
    this.walk(name, '$', actual, expected);
    return this;
  }
  ok() { if (this.problems.length) throw new Error(`contract mismatches:\n  ${this.problems.join('\n  ')}`); }

  private walk(name: string, path: string, actual: unknown, expected: unknown) {
    const where = `${name} ${path}`;
    const typeOf = (x: unknown) => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x;
    if (typeOf(expected) !== typeOf(actual)) {
      // A fixture null (e.g. last_used_at before first use) may be a timestamp once used.
      if (!(expected === null && typeof actual === 'string' && RFC3339.test(actual) && /_at$/.test(path))) this.problems.push(`${where}: expected ${typeOf(expected)}, got ${typeOf(actual)} (${JSON.stringify(actual)})`);
      return;
    }
    if (Array.isArray(expected)) {
      const a = actual as unknown[];
      if (a.length !== expected.length) { this.problems.push(`${where}: expected ${expected.length} items, got ${a.length}`); return; }
      expected.forEach((item, i) => this.walk(name, `${path}[${i}]`, a[i], item));
      return;
    }
    if (expected && typeof expected === 'object') {
      const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>;
      for (const key of Object.keys(e)) if (!(key in a)) this.problems.push(`${where}.${key}: missing`);
      for (const key of Object.keys(a)) if (!(key in e)) this.problems.push(`${where}.${key}: not in the contract`);
      for (const key of Object.keys(e)) if (key in a) this.walk(name, `${path}.${key}`, a[key], e[key]);
      return;
    }
    if (typeof expected === 'string') return this.string(where, actual as string, expected);
    if (actual !== expected) this.problems.push(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  private string(where: string, actual: string, expected: string) {
    if (RFC3339.test(expected)) { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(actual)) this.problems.push(`${where}: expected an RFC 3339 UTC timestamp, got ${actual}`); return; }
    // Example ids carry "fixture" (call_fixture_incoming); event ids are generated even when they do not (evt_text_ready).
    const id = /^([a-z]+)_fixture(?:_[a-z0-9]+)*$/.exec(expected) ?? /^(evt)_[a-z0-9_]+$/.exec(expected);
    if (id) {
      if (!actual.startsWith(`${id[1]}_`) || actual.length < id[1].length + 4) { this.problems.push(`${where}: expected a ${id[1]}_ id, got ${actual}`); return; }
      this.bind(where, expected, actual);
      return;
    }
    if (/^fixture-/.test(expected)) { if (!actual) this.problems.push(`${where}: expected a non-empty value`); return; }
    if (/^(https|wss):\/\//.test(expected)) {
      let substituted = expected;
      for (const [fixtureId, real] of this.ids) substituted = substituted.split(fixtureId).join(real);
      if (substituted !== actual) this.problems.push(`${where}: expected ${substituted}, got ${actual}`);
      return;
    }
    if (actual !== expected) this.problems.push(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  private bind(where: string, fixtureId: string, real: string) {
    const known = this.ids.get(fixtureId);
    if (known && known !== real) this.problems.push(`${where}: ${fixtureId} was ${known} earlier in the scenario, now ${real}`);
    for (const [other, value] of this.ids) if (other !== fixtureId && value === real) this.problems.push(`${where}: ${real} stands for both ${other} and ${fixtureId}`);
    this.ids.set(fixtureId, real);
  }
}
