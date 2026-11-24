# Values the contract leaves open

Sections 2 and 3 of [PROTOCOL.md](../../Docs/PROTOCOL.md) are the contract, and nothing here changes them. Every fixture-covered response and
event matches its fixture key for key. This page lists what the server sends where the contract shows no example,
so the apps can decode it. None of these values is a new endpoint, field or event in a fixture-covered message.

| Where | What the server sends |
|---|---|
| `call.state` (in `GET /calls/{id}`, decline and end responses) | `ringing`, `connecting` (answered or dialled, text channel not yet open), `active` (text channel open), `ended`. |
| `call.ended.reason` | `user` (end or every signalled device declined), `focus`, `quiet_hours` or `calls_disabled` (a restrictive decline or published phone policy), `no_answer` (ring expired), `caller` (the connector hung up), `switchboard_restart`. |
| `GET /calls/{id}` | The incoming fields (or `target`/`started_at` for outgoing), plus `owner_device_id` once answered, `target_binding` and `text_channel` for the owner while live, and `ended_at` with `end_reason` once ended. |
| `GET /me` | `device_id`, `name`, `platform`, `app_version`, `installation_id`, `paired_at`, `acknowledged`, `push_registered`, `profile`. |
| `PUT /devices/me/push` response | `{"device_id", "push_registered": true, "environment"}`. Only the iOS app may call it; the Mac gets `forbidden`. |
| `PUT /devices/me/availability` response | The effective `{calls_allowed, reason, valid_until}`. `calls_allowed` must be true exactly when `reason` is `available`. A restrictive state that is still valid declines every ringing call on both devices, and while it holds, a new caller-token call is recorded and ended unsignalled with that reason. |
| decline, end responses | `{"call": <GET /calls/{id} view>}`. |
| `POST /calls/{id}/backend-handoff` response | `{"backend": <handout>}`, the same object as in the accept response. |
| `turn.accepted.fallback_reason` | `null` when the effective delivery is the requested one. |
| `reply.done.status` | `completed`, or `failed` when the lane could not answer (the connector dropped, or the pinned conversation moved). |
| Text channel errors | `{"type": "error", "error": {code, message, retryable, operation_id}}`: the HTTP error envelope as a frame, e.g. `operation_conflict` for a changed turn under a used id, or `target_unavailable` with `retryable: true` when no connector is connected (the turn was not admitted). |
| Duplicate `turn.submit` | The recorded `turn.accepted` again, and the recorded `reply.done` if the reply has finished. Otherwise the remaining deltas follow. Nothing is delivered twice. |
| Status codes | All success responses are `200`, except `DELETE /caller-tokens/{id}` (`204`). Errors use the status listed in `src/server/errors.ts`; an unknown call or token is `404` with code `call_not_active` or `validation_error`. |

Steer: the `native` lane cannot steer a running turn, so every requested `steer` is answered with
`effective_delivery: queue` and `fallback_reason: steer_not_supported`. The app shows the fallback once and never
replays the turn.

Lost creation response for a caller token: a repeat with the same `operation_id` and body reissues the secret and
replaces the stored hash, while the token is still unused. The undelivered secret is never stored, so it cannot be
returned again. Once the token has been used or revoked, the repeat returns `operation_conflict`.

## Additions outside the fixtures

These routes were added after the fixture-covered contract and have no example in PROTOCOL.md:

| Route | What it does |
|---|---|
| `GET /targets` extra rows | When the connector's lane has a catalog, its conversations follow the configured targets as `{id: "session:<id>", label, project, available}` (plus whatever else the lane reports). Dialling one pins that conversation for the call. |
| `GET /settings/speech` | The shared voice for a paired device: the active profile's voice and the voices its backend lists. |
| `PUT /settings/speech` | `{operation_id, voice}` selects the shared voice for new calls. A call already placed keeps its voice. |
| `POST /settings/speech/preview` | `{voice}` asks the active backend to synthesize a short sample in that voice without changing the selection. |
| `/settings`, `/settings/api/*` | The browser settings page for voice profiles, behind the admin password. See [voice-settings.md](voice-settings.md). |
