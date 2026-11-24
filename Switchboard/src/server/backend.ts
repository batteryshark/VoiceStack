import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Backend } from './config.ts';
import { newId, rfc3339 } from '../common/util.ts';

/**
 * Short-lived backend credentials. The local adapter verifies them offline with Switchboard's public key
 * (Docs/PROTOCOL.md section 5): signature, audience, profile, call binding and expiry. Format:
 *   sbb1.<base64url(JSON claims)>.<base64url(Ed25519 signature over "sbb1.<claims>")>
 * Claims: {v:1, aud, profile, call_id, binding, device_id, iat, exp, jti} (epoch seconds).
 */
export type Claims = { v: 1; aud: string; profile: string; call_id: string; binding: string; device_id: string; iat: number; exp: number; jti: string; voice?: string };

export class Signer {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  constructor(path: string) {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
    }
    this.privateKey = createPrivateKey(readFileSync(path));
    this.publicKey = createPublicKey(this.privateKey);
  }
  publicPem(): string { return this.publicKey.export({ type: 'spki', format: 'pem' }) as string; }

  management(backend: Backend, method: string, path: string, nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const claims = { v: 1, aud: backend.audience, scope: 'speech.settings', method, path, iat, exp: iat + 60, jti: newId('admin') };
    const body = `sba1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${body}.${sign(null, Buffer.from(body), this.privateKey).toString('base64url')}`;
  }

  issue(backend: Backend, callId: string, binding: string, deviceId: string, nowMs: number, ttlSeconds: number) {
    const iat = Math.floor(nowMs / 1000);
    const claims: Claims = { v: 1, aud: backend.audience, profile: backend.profile, call_id: callId, binding, device_id: deviceId, iat, exp: iat + ttlSeconds, jti: newId('bc'), ...(backend.voice ? { voice: backend.voice } : {}) };
    const body = `sbb1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const signature = sign(null, Buffer.from(body), this.privateKey).toString('base64url');
    return { credential: `${body}.${signature}`, expires_at: rfc3339((iat + ttlSeconds) * 1000), claims };
  }
}

/** Offline check a backend runs; exported for tests and as reference for the adapter. */
export function verifyCredential(credential: string, publicKey: KeyObject, expect: { aud: string; profile: string; call_id?: string; nowMs: number }): Claims {
  const parts = credential.split('.');
  if (parts.length !== 3 || parts[0] !== 'sbb1') throw new Error('malformed');
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Claims;
  if (claims.aud !== expect.aud) throw new Error('wrong audience');
  if (claims.profile !== expect.profile) throw new Error('wrong profile');
  if (expect.call_id && claims.call_id !== expect.call_id) throw new Error('wrong call');
  if (claims.exp * 1000 <= expect.nowMs) throw new Error('expired');
  return claims;
}

/** Readiness: the active backend's health probe answers {"status":"ok"} within the bound. */
export async function backendReady(backend: Backend, timeoutMs = 30000): Promise<boolean> {
  try {
    const response = await fetch(backend.health_url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { status?: string };
    return body.status === 'ok';
  } catch { return false; }
}
