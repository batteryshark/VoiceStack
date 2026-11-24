/** The contract's error codes (Docs/PROTOCOL.md section 2.1) and the HTTP status each one carries. */
export const CODES = {
  unauthorized: 401,
  forbidden: 403,
  validation_error: 400,
  operation_conflict: 409,
  call_taken: 409,
  call_not_active: 409,
  target_unavailable: 503,
  backend_unavailable: 503,
  token_active: 409,
  token_revoked: 403,
  profile_unsupported: 400,
} as const;

export type Code = keyof typeof CODES;

export class ApiError extends Error {
  constructor(readonly code: Code, message: string, readonly options: { status?: number; retryable?: boolean; operation_id?: string | null } = {}) {
    super(message);
  }
  get status() { return this.options.status ?? CODES[this.code]; }
  body(operationId?: string | null) {
    const retryable = this.options.retryable ?? (this.code === 'target_unavailable' || this.code === 'backend_unavailable');
    return { error: { code: this.code, message: this.message, retryable, operation_id: this.options.operation_id ?? operationId ?? null } };
  }
}

export const fail = (code: Code, message: string, options?: ApiError['options']) => new ApiError(code, message, options);
