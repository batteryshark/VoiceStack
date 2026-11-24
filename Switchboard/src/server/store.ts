import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256 } from '../common/util.ts';

/**
 * Switchboard's records. Every bearer secret (pairing codes, device credentials, caller tokens, connector
 * credentials) is stored only as its sha256; no row holds a secret, audio or a backend credential.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_code (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE, paired_at TEXT NOT NULL, acknowledged_at TEXT, revoked_at TEXT,
  push_environment TEXT, push_bundle_id TEXT, push_voip_token TEXT, push_updated_at TEXT,
  calls_allowed INTEGER, availability_reason TEXT, availability_valid_until TEXT, availability_updated_at TEXT);
CREATE TABLE IF NOT EXISTS caller_token (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, deleted_at TEXT, created_by_device TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connector_credential (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS operation (
  scope TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT,
  at TEXT NOT NULL, PRIMARY KEY (scope, operation_id));
CREATE TABLE IF NOT EXISTS call (
  id TEXT PRIMARY KEY, direction TEXT NOT NULL, state TEXT NOT NULL,
  caller_token_id TEXT, caller_name TEXT, subject TEXT,
  target_id TEXT NOT NULL, target_label TEXT NOT NULL, target_binding TEXT NOT NULL, lane_ref TEXT NOT NULL,
  owner_device_id TEXT, backend_id TEXT, backend_profile TEXT,
  started_at TEXT NOT NULL, ring_expires_at TEXT, accepted_at TEXT, ended_at TEXT, end_reason TEXT, ended_by TEXT);
CREATE TABLE IF NOT EXISTS call_signal (call_id TEXT NOT NULL, device_id TEXT NOT NULL, route TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS call_decline (call_id TEXT NOT NULL, device_id TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (call_id, device_id));
CREATE TABLE IF NOT EXISTS call_request (
  at TEXT NOT NULL, caller_token_id TEXT, operation_id TEXT, result TEXT NOT NULL, call_id TEXT);
CREATE TABLE IF NOT EXISTS turn (
  call_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response_id TEXT NOT NULL,
  requested_delivery TEXT NOT NULL, effective_delivery TEXT NOT NULL, fallback_reason TEXT,
  status TEXT NOT NULL, text_chars INTEGER NOT NULL, reply_chars INTEGER, submitted_at TEXT NOT NULL, done_at TEXT,
  PRIMARY KEY (call_id, operation_id));
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type Device = {
  id: string; installation_id: string; name: string; platform: 'ios' | 'macos'; app_version: string; credential_hash: string;
  paired_at: string; acknowledged_at: string | null; revoked_at: string | null;
  push_environment: string | null; push_bundle_id: string | null; push_voip_token: string | null; push_updated_at: string | null;
  calls_allowed: number | null; availability_reason: string | null; availability_valid_until: string | null; availability_updated_at: string | null;
};
export type CallerToken = {
  id: string; name: string; secret_hash: string; state: 'active' | 'revoked'; created_at: string; last_used_at: string | null;
  revoked_at: string | null; deleted_at: string | null; created_by_device: string;
};
export type Call = {
  id: string; direction: 'incoming' | 'outgoing'; state: 'ringing' | 'connecting' | 'active' | 'ended';
  caller_token_id: string | null; caller_name: string | null; subject: string | null;
  target_id: string; target_label: string; target_binding: string; lane_ref: string;
  owner_device_id: string | null; backend_id: string | null; backend_profile: string | null;
  started_at: string; ring_expires_at: string | null; accepted_at: string | null; ended_at: string | null; end_reason: string | null; ended_by: string | null;
};
export type Turn = {
  call_id: string; operation_id: string; fingerprint: string; response_id: string; requested_delivery: string; effective_delivery: string;
  fallback_reason: string | null; status: string; text_chars: number; reply_chars: number | null; submitted_at: string; done_at: string | null;
};
export type Operation = { scope: string; operation_id: string; fingerprint: string; status: number; response: string | null; at: string };

export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // Pairing codes: one use, hash only.
  addPairingCode(code: string, at: string) { this.db.query('INSERT INTO pairing_code (hash, created_at) VALUES (?, ?)').run(sha256(code), at); }
  /** Marks the code used and returns true when it existed unused. */
  usePairingCode(code: string, at: string): boolean {
    return this.db.query('UPDATE pairing_code SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(at, sha256(code)).changes === 1;
  }

  // Devices.
  addDevice(device: Omit<Device, 'acknowledged_at' | 'revoked_at' | 'push_environment' | 'push_bundle_id' | 'push_voip_token' | 'push_updated_at' | 'calls_allowed' | 'availability_reason' | 'availability_valid_until' | 'availability_updated_at'>) {
    this.db.query('INSERT INTO device (id, installation_id, name, platform, app_version, credential_hash, paired_at) VALUES ($id, $installation_id, $name, $platform, $app_version, $credential_hash, $paired_at)').run(device);
  }
  deviceByCredential(secret: string): Device | null {
    return this.db.query('SELECT * FROM device WHERE credential_hash = ? AND revoked_at IS NULL').get(sha256(secret)) as Device | null;
  }
  device(id: string): Device | null { return this.db.query('SELECT * FROM device WHERE id = ?').get(id) as Device | null; }
  devices(): Device[] { return this.db.query('SELECT * FROM device ORDER BY paired_at').all() as Device[]; }
  activeDevices(): Device[] { return this.db.query('SELECT * FROM device WHERE revoked_at IS NULL AND acknowledged_at IS NOT NULL ORDER BY paired_at').all() as Device[]; }
  /** Earlier pairings of the same installation are retired when it pairs again. */
  retireInstallation(installationId: string, keep: string, at: string) {
    this.db.query('UPDATE device SET revoked_at = ? WHERE installation_id = ? AND id != ? AND revoked_at IS NULL').run(at, installationId, keep);
  }
  acknowledge(id: string, at: string) { this.db.query('UPDATE device SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?').run(at, id); }
  revokeDevice(id: string, at: string) { return this.db.query('UPDATE device SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes === 1; }
  setPush(id: string, environment: string, bundleId: string, voipToken: string, at: string) {
    this.db.query('UPDATE device SET push_environment = ?, push_bundle_id = ?, push_voip_token = ?, push_updated_at = ? WHERE id = ?').run(environment, bundleId, voipToken, at, id);
  }
  setAvailability(id: string, allowed: boolean, reason: string, validUntil: string, at: string) {
    this.db.query('UPDATE device SET calls_allowed = ?, availability_reason = ?, availability_valid_until = ?, availability_updated_at = ? WHERE id = ?').run(allowed ? 1 : 0, reason, validUntil, at, id);
  }

  // Caller tokens: hash only; the secret leaves the server once, in the creation response.
  addCallerToken(token: Pick<CallerToken, 'id' | 'name' | 'secret_hash' | 'created_at' | 'created_by_device'>) {
    this.db.query("INSERT INTO caller_token (id, name, secret_hash, state, created_at, created_by_device) VALUES ($id, $name, $secret_hash, 'active', $created_at, $created_by_device)").run(token);
  }
  callerTokenBySecret(secret: string): CallerToken | null {
    return this.db.query('SELECT * FROM caller_token WHERE secret_hash = ? AND deleted_at IS NULL').get(sha256(secret)) as CallerToken | null;
  }
  callerToken(id: string): CallerToken | null { return this.db.query('SELECT * FROM caller_token WHERE id = ? AND deleted_at IS NULL').get(id) as CallerToken | null; }
  callerTokens(): CallerToken[] { return this.db.query('SELECT * FROM caller_token WHERE deleted_at IS NULL ORDER BY created_at, rowid').all() as CallerToken[]; }
  revokeCallerToken(id: string, at: string) { this.db.query("UPDATE caller_token SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(at, id); }
  deleteCallerToken(id: string, at: string) { this.db.query('UPDATE caller_token SET deleted_at = ? WHERE id = ?').run(at, id); }
  touchCallerToken(id: string, at: string) { this.db.query('UPDATE caller_token SET last_used_at = ? WHERE id = ?').run(at, id); }

  // Connector credentials.
  addConnectorCredential(id: string, name: string, secret: string, at: string) {
    this.db.query('INSERT INTO connector_credential (id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, sha256(secret), at);
  }
  connectorBySecret(secret: string) {
    return this.db.query('SELECT id, name FROM connector_credential WHERE secret_hash = ? AND revoked_at IS NULL').get(sha256(secret)) as { id: string; name: string } | null;
  }
  revokeConnector(id: string, at: string) { return this.db.query('UPDATE connector_credential SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes === 1; }

  // Idempotency by operation_id within a scope (one credential, or one call's text channel).
  operation(scope: string, operationId: string): Operation | null {
    return this.db.query('SELECT * FROM operation WHERE scope = ? AND operation_id = ?').get(scope, operationId) as Operation | null;
  }
  recordOperation(op: Operation) {
    this.db.query('INSERT INTO operation (scope, operation_id, fingerprint, status, response, at) VALUES ($scope, $operation_id, $fingerprint, $status, $response, $at)').run(op);
  }

  // Calls.
  addCall(call: Call) {
    this.db.query(`INSERT INTO call (id, direction, state, caller_token_id, caller_name, subject, target_id, target_label, target_binding, lane_ref,
      owner_device_id, backend_id, backend_profile, started_at, ring_expires_at, accepted_at, ended_at, end_reason, ended_by)
      VALUES ($id, $direction, $state, $caller_token_id, $caller_name, $subject, $target_id, $target_label, $target_binding, $lane_ref,
      $owner_device_id, $backend_id, $backend_profile, $started_at, $ring_expires_at, $accepted_at, $ended_at, $end_reason, $ended_by)`).run(call);
  }
  call(id: string): Call | null { return this.db.query('SELECT * FROM call WHERE id = ?').get(id) as Call | null; }
  calls(limit = 50): Call[] { return this.db.query('SELECT * FROM call ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Call[]; }
  callsInState(...states: Call['state'][]): Call[] {
    return this.db.query(`SELECT * FROM call WHERE state IN (${states.map(() => '?').join(',')})`).all(...states) as Call[];
  }
  /** Accepting is a compare-and-set on the ringing state: the first device wins. */
  claimCall(id: string, deviceId: string, backendId: string, backendProfile: string, at: string): boolean {
    return this.db.query("UPDATE call SET state = 'connecting', owner_device_id = ?, backend_id = ?, backend_profile = ?, accepted_at = ? WHERE id = ? AND state = 'ringing'")
      .run(deviceId, backendId, backendProfile, at, id).changes === 1;
  }
  setCallState(id: string, state: Call['state']) { this.db.query("UPDATE call SET state = ? WHERE id = ? AND state != 'ended'").run(state, id); }
  endCall(id: string, reason: string, by: string, at: string): boolean {
    return this.db.query("UPDATE call SET state = 'ended', ended_at = ?, end_reason = ?, ended_by = ? WHERE id = ? AND state != 'ended'").run(at, reason, by, id).changes === 1;
  }
  setCallBackend(id: string, backendId: string, profile: string) { this.db.query('UPDATE call SET backend_id = ?, backend_profile = ? WHERE id = ?').run(backendId, profile, id); }
  addSignal(callId: string, deviceId: string, route: string, result: string, at: string) {
    this.db.query('INSERT INTO call_signal (call_id, device_id, route, result, at) VALUES (?, ?, ?, ?, ?)').run(callId, deviceId, route, result, at);
  }
  signals(callId: string) { return this.db.query('SELECT device_id, route, result, at FROM call_signal WHERE call_id = ? ORDER BY rowid').all(callId) as { device_id: string; route: string; result: string; at: string }[]; }
  addDecline(callId: string, deviceId: string, reason: string, at: string) {
    this.db.query('INSERT OR IGNORE INTO call_decline (call_id, device_id, reason, at) VALUES (?, ?, ?, ?)').run(callId, deviceId, reason, at);
  }
  declines(callId: string) { return this.db.query('SELECT device_id, reason, at FROM call_decline WHERE call_id = ?').all(callId) as { device_id: string; reason: string; at: string }[]; }
  /** Every caller-token call request and its result, refused ones included. */
  addCallRequest(at: string, tokenId: string | null, operationId: string | null, result: string, callId: string | null) {
    this.db.query('INSERT INTO call_request (at, caller_token_id, operation_id, result, call_id) VALUES (?, ?, ?, ?, ?)').run(at, tokenId, operationId, result, callId);
  }
  callRequests(limit = 50) { return this.db.query('SELECT * FROM call_request ORDER BY rowid DESC LIMIT ?').all(limit) as { at: string; caller_token_id: string | null; operation_id: string | null; result: string; call_id: string | null }[]; }

  // Turns: counts and outcomes only; the words live in the conversation, not here.
  turn(callId: string, operationId: string): Turn | null { return this.db.query('SELECT * FROM turn WHERE call_id = ? AND operation_id = ?').get(callId, operationId) as Turn | null; }
  turns(callId: string): Turn[] { return this.db.query('SELECT * FROM turn WHERE call_id = ? ORDER BY submitted_at, rowid').all(callId) as Turn[]; }
  addTurn(turn: Turn) {
    this.db.query(`INSERT INTO turn (call_id, operation_id, fingerprint, response_id, requested_delivery, effective_delivery, fallback_reason, status, text_chars, reply_chars, submitted_at, done_at)
      VALUES ($call_id, $operation_id, $fingerprint, $response_id, $requested_delivery, $effective_delivery, $fallback_reason, $status, $text_chars, $reply_chars, $submitted_at, $done_at)`).run(turn);
  }
  finishTurn(callId: string, operationId: string, status: string, replyChars: number, at: string) {
    this.db.query('UPDATE turn SET status = ?, reply_chars = ?, done_at = ? WHERE call_id = ? AND operation_id = ?').run(status, replyChars, at, callId, operationId);
  }

  setting(key: string): string | null { return (this.db.query('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | null)?.value ?? null; }
  setSetting(key: string, value: string) { this.db.query('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
}
