import { readFileSync, statSync } from 'node:fs';

/**
 * Where a secret lives. Today only a protected file the operator configures; a keychain or secret-service
 * reference can be added here later without touching the callers, which go through readSecret() alone.
 */
export type SecretRef = { file: string };

export function readSecret(ref: SecretRef): string {
  if (!ref || typeof ref.file !== 'string') throw new Error('secret reference must name a file');
  const stat = statSync(ref.file);
  if (!stat.isFile()) throw new Error(`${ref.file} is not a file`);
  // Protected means no access for others; a service group (root:GROUP 0440) is a valid owner.
  if (stat.mode & 0o007) throw new Error(`${ref.file} must not be accessible to others (chmod 600 or 640)`);
  const value = readFileSync(ref.file, 'utf8').trim();
  if (!value) throw new Error(`${ref.file} is empty`);
  return value;
}
