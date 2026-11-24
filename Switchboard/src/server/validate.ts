import { fail } from './errors.ts';
import { RFC3339, UUID } from '../common/util.ts';

type Body = Record<string, unknown>;

/** Unknown request fields are rejected (PROTOCOL.md section 2.1). */
export function object(value: unknown, allowed: string[], where = 'body'): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('validation_error', `${where} must be a JSON object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw fail('validation_error', `unknown field ${where === 'body' ? '' : where + '.'}${unknown[0]}`);
  return value as Body;
}

export function string(body: Body, key: string, options: { min?: number; max?: number; optional?: boolean } = {}): string {
  const value = body[key];
  if (value === undefined && options.optional) return '';
  if (typeof value !== 'string') throw fail('validation_error', `${key} must be a string`);
  const length = [...value].length;
  if (length < (options.min ?? 1) || length > (options.max ?? 200)) throw fail('validation_error', `${key} must contain ${options.min ?? 1} to ${options.max ?? 200} characters`);
  return value;
}

export function oneOf<T extends string>(body: Body, key: string, values: readonly T[]): T {
  const value = body[key];
  if (typeof value !== 'string' || !values.includes(value as T)) throw fail('validation_error', `${key} must be one of ${values.join(', ')}`);
  return value as T;
}

export function operationId(body: Body): string {
  const value = body.operation_id;
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('validation_error', 'operation_id must be a UUID');
  return value.toLowerCase();
}

export function uuid(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('validation_error', `${key} must be a UUID`);
  return value.toLowerCase();
}

export function boolean(body: Body, key: string): boolean {
  if (typeof body[key] !== 'boolean') throw fail('validation_error', `${key} must be true or false`);
  return body[key] as boolean;
}

export function timestamp(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw fail('validation_error', `${key} must be an RFC 3339 timestamp`);
  return value;
}

/** A subject contains 1 to 60 characters after trimming (PROTOCOL.md section 2.5). */
export function subject(body: Body): string {
  const value = body.subject;
  if (typeof value !== 'string') throw fail('validation_error', 'subject must contain 1 to 60 characters');
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > 60) throw fail('validation_error', 'subject must contain 1 to 60 characters');
  return trimmed;
}
