import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** RFC 3339 UTC to the second, as the contract's examples write it. */
export function rfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** An opaque id with a typed prefix, e.g. call_k3x9... */
export function newId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** A high-entropy bearer secret. Only its sha256 is ever stored. */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/** A one-use pairing code a person can type: five groups of four. */
export function newPairingCode(): string {
  const raw = newId('x', 20).slice(2);
  return raw.match(/.{4}/g)!.join('-');
}

export { randomUUID };

/** Canonical JSON (sorted keys) for operation fingerprints. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
