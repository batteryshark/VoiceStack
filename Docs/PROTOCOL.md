# VoiceStack protocol

This is the wire contract between the three parts of VoiceStack: the native apps, the Switchboard server and a
speech backend. The app contract is `voicestack-app/1`; the speech profile is `voicestack-mode-a-speech/1`.

The JSON examples in sections 2 and 3 are the contract. `Switchboard/scripts/extract-fixtures.ts` extracts them
into `Switchboard/test/fixtures/contract/`, and the server tests fail if a fixture and this document disagree.
The app's own copies are in `Fixtures/`. Values the examples leave open are listed in
[Switchboard/docs/contract-notes.md](../Switchboard/docs/contract-notes.md); the credential format, renewal
behaviour and audio limits are in [INTEGRATION.md](INTEGRATION.md).

## 1. Roles and boundary

- The apps pair with Switchboard, manage caller tokens and own each call's text relay.
- The apps send captured audio directly to the active speech backend, which returns text to the apps. The speech
  backend never talks to Switchboard.
- The apps send the final user text to Switchboard. Switchboard relays it through its connector into the agent
  conversation and returns the agent's reply text.
- The apps send reply text directly to the speech backend for synthesis and play the audio it returns.
- Switchboard chooses the active backend and gives the app its addresses and a short-lived credential per call.

```text
your audio
  → app
  → speech backend (speech-to-text)
  → app
  → Switchboard text channel
  → connector
  → pinned agent conversation
  → Switchboard text channel
  → app
  → speech backend (text-to-speech)
  → app playback
```

Audio never passes through Switchboard. This is "Mode A": speech conversion on both sides of a text conversation.
A speech-to-speech mode is not part of this contract; the handout's `mode` field leaves room for one.

## 2. App contract

The app contract is `voicestack-app/1`.

Examples use reserved `.invalid` hosts and `fixture-` values. They are not live addresses or credentials.

### 2.1 Common rules

- Example base: `https://switchboard.fixture.invalid/voicestack/v1`.
- Use JSON over HTTPS and JSON text frames over WebSocket.
- Use `Authorization: Bearer <device credential>` after pairing.
- Credentials never appear in query strings.
- Timestamps are RFC 3339 UTC.
- Operation identifiers are app-generated UUIDs.
- IDs and target bindings are opaque.
- Unknown request fields are rejected. Clients ignore unknown response fields.
- Mutations are idempotent by `operation_id`.
- No route returns conversation history or a raw agent session ID.

HTTP errors use:

```json
{
  "error": {
    "code": "validation_error",
    "message": "subject must contain 1 to 60 characters",
    "retryable": false,
    "operation_id": "11111111-1111-4111-8111-111111111111"
  }
}
```

Required codes are `unauthorized`, `forbidden`, `validation_error`, `operation_conflict`, `call_taken`, `call_not_active`, `target_unavailable`, `backend_unavailable`, `token_active`, `token_revoked` and `profile_unsupported`.

### 2.2 Pairing

The operator prints a one-use pairing code with `switchboard pairing-code`. The user types it into the app's pairing screen. It never goes in a link, log or source file.

`POST /pair`

```json
{
  "profile": "voicestack-app/1",
  "pairing_code": "fixture-one-use-code",
  "device": {
    "installation_id": "22222222-2222-4222-8222-222222222222",
    "name": "Example iPhone",
    "platform": "ios",
    "app_version": "1.0"
  }
}
```

Response:

```json
{
  "device_id": "dev_fixture_iphone",
  "device_credential": "fixture-device-credential-not-secret",
  "paired_at": "2026-10-29T12:00:00Z",
  "profile": "voicestack-app/1"
}
```

Store the returned credential in Keychain before acknowledgement.

`POST /pair/ack`, with the new device credential:

```json
{
  "operation_id": "33333333-3333-4333-8333-333333333333",
  "installation_id": "22222222-2222-4222-8222-222222222222"
}
```

Response:

```json
{"paired": true, "device_id": "dev_fixture_iphone"}
```

`GET /me` returns paired metadata. Use it to reconcile an uncertain acknowledgement. Do not restart pairing blindly.

The iOS app registers its VoIP token with `PUT /devices/me/push`:

```json
{
  "operation_id": "44444444-4444-4444-8444-444444444444",
  "environment": "sandbox",
  "bundle_id": "fixture.voicestack",
  "voip_token": "fixture-apns-device-token"
}
```

The Mac app does not call this route.

The iOS app publishes the phone policy that governs both devices through `PUT /devices/me/availability`:

```json
{
  "operation_id": "55555555-5555-4555-8555-555555555555",
  "calls_allowed": false,
  "reason": "focus",
  "valid_until": "2026-10-29T12:05:00Z"
}
```

Allowed reasons are `available`, `focus`, `quiet_hours` and `calls_disabled`. Use supported Apple APIs only. The iOS app also reports a restrictive state while handling a call signal.

### 2.3 Caller-token lifecycle

`POST /caller-tokens`

```json
{
  "operation_id": "66666666-6666-4666-8666-666666666666",
  "name": "Agent"
}
```

The `secret` appears only in the creation response:

```json
{
  "token": {
    "id": "ctok_fixture_agent",
    "name": "Agent",
    "state": "active",
    "created_at": "2026-10-29T12:10:00Z",
    "last_used_at": null
  },
  "secret": "fixture-caller-token-shown-once"
}
```

`GET /caller-tokens`:

```json
{
  "tokens": [
    {
      "id": "ctok_fixture_agent",
      "name": "Agent",
      "state": "active",
      "created_at": "2026-10-29T12:10:00Z",
      "last_used_at": null
    }
  ]
}
```

`POST /caller-tokens/ctok_fixture_agent/revoke`

```json
{"operation_id": "77777777-7777-4777-8777-777777777777"}
```

Response:

```json
{
  "id": "ctok_fixture_agent",
  "name": "Agent",
  "state": "revoked",
  "revoked_at": "2026-10-29T12:15:00Z",
  "last_used_at": "2026-10-29T12:14:00Z"
}
```

`DELETE /caller-tokens/ctok_fixture_agent` takes an `operation_id` JSON body and returns `204 No Content`. Deleting an active token returns `409 token_active`.

### 2.4 Targets and outgoing dial-in

`GET /targets`:

```json
{
  "targets": [
    {
      "id": "target_main",
      "label": "Agent",
      "kind": "main_conversation",
      "is_default": true,
      "available": true
    },
    {
      "id": "target_fixture_project",
      "label": "Example project",
      "kind": "conversation",
      "is_default": false,
      "available": true
    }
  ]
}
```

The app selects `is_default:true` unless the user chooses another target.

A paired device starts an outgoing call with `POST /calls`:

```json
{
  "operation_id": "88888888-8888-4888-8888-888888888888",
  "direction": "outgoing",
  "target_id": "target_main"
}
```

Response:

```json
{
  "call": {
    "id": "call_fixture_outgoing",
    "direction": "outgoing",
    "state": "connecting",
    "target": {"id": "target_main", "label": "Agent"},
    "target_binding": "binding_fixture_1",
    "text_channel": "wss://switchboard.fixture.invalid/voicestack/v1/calls/call_fixture_outgoing/text",
    "started_at": "2026-10-29T12:20:00Z"
  },
  "backend": {
    "mode": "A",
    "profile": "voicestack-mode-a-speech/1",
    "transcription_address": "wss://voice-mac.fixture.invalid/v1/realtime?intent=transcription",
    "speech_address": "https://voice-mac.fixture.invalid/v1/audio/speech",
    "credential": "fixture-short-lived-backend-credential",
    "expires_at": "2026-10-29T12:21:00Z"
  }
}
```

`target_binding` proves Switchboard pinned the target. The app never interprets it.

### 2.5 Caller-token call request

This is the route an agent's call tool uses (`switchboard-connector call`). The apps do not call it.

A caller token uses `POST /calls`:

```json
{
  "operation_id": "99999999-9999-4999-8999-999999999999",
  "direction": "incoming",
  "subject": "Need to settle the release boundary"
}
```

The bearer fixes caller identity. The request cannot supply caller name, target or backend. A subject contains 1 to 60 characters after trimming.

Response:

```json
{
  "call": {
    "id": "call_fixture_incoming",
    "direction": "incoming",
    "state": "ringing",
    "caller_name": "Agent",
    "subject": "Need to settle the release boundary",
    "ring_expires_at": "2026-10-29T12:31:00Z"
  }
}
```

Switchboard emits the incoming signal only after the target is prepared and the active backend reports ready.

### 2.6 Incoming-call signals

The open Mac app connects to `WSS /device/events`. The first event is:

```json
{
  "type": "device.ready",
  "event_id": "evt_fixture_ready",
  "profile": "voicestack-app/1"
}
```

An incoming call is:

```json
{
  "type": "call.incoming",
  "event_id": "evt_fixture_incoming",
  "call": {
    "id": "call_fixture_incoming",
    "direction": "incoming",
    "state": "ringing",
    "caller_name": "Agent",
    "subject": "Need to settle the release boundary",
    "ring_expires_at": "2026-10-29T12:31:00Z"
  }
}
```

The iOS VoIP payload carries the same display fields:

```json
{
  "aps": {},
  "voicestack": {
    "profile": "voicestack-app/1",
    "event": "call.incoming",
    "event_id": "evt_fixture_incoming",
    "call_id": "call_fixture_incoming",
    "caller_name": "Agent",
    "subject": "Need to settle the release boundary",
    "ring_expires_at": "2026-10-29T12:31:00Z"
  }
}
```

The iOS app reports the call to CallKit promptly, then reconciles with `GET /calls/call_fixture_incoming`. A notification tap is not an answer.

### 2.7 Accept, decline, ownership and end

Accept with `POST /calls/call_fixture_incoming/accept`:

```json
{"operation_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
```

The winning response is:

```json
{
  "call": {
    "id": "call_fixture_incoming",
    "direction": "incoming",
    "state": "connecting",
    "owner_device_id": "dev_fixture_mac",
    "caller_name": "Agent",
    "subject": "Need to settle the release boundary",
    "target_binding": "binding_fixture_2",
    "text_channel": "wss://switchboard.fixture.invalid/voicestack/v1/calls/call_fixture_incoming/text"
  },
  "backend": {
    "mode": "A",
    "profile": "voicestack-mode-a-speech/1",
    "transcription_address": "wss://voice-mac.fixture.invalid/v1/realtime?intent=transcription",
    "speech_address": "https://voice-mac.fixture.invalid/v1/audio/speech",
    "credential": "fixture-short-lived-backend-credential",
    "expires_at": "2026-10-29T12:32:00Z"
  }
}
```

A later accept returns `409 call_taken`. The losing device also receives:

```json
{
  "type": "call.taken",
  "event_id": "evt_fixture_taken",
  "call_id": "call_fixture_incoming"
}
```

Decline with `POST /calls/{call_id}/decline`:

```json
{
  "operation_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "reason": "focus"
}
```

Allowed reasons are `user`, `focus`, `quiet_hours` and `calls_disabled`. A restrictive phone-policy decline ends presentation on both devices.

End with `POST /calls/{call_id}/end`:

```json
{
  "operation_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "reason": "user"
}
```

All devices and the text channel receive:

```json
{
  "type": "call.ended",
  "event_id": "evt_fixture_ended",
  "call_id": "call_fixture_incoming",
  "reason": "user"
}
```

If a handout expires before speech attachment, the owning device calls `POST /calls/{call_id}/backend-handoff` with a new operation identifier. It returns a fresh handout only for the same active owner.

## 3. Text channel

The owning app connects to the returned `text_channel` with its device credential. The backend credential is not used here.

The first event is:

```json
{
  "type": "call.ready",
  "event_id": "evt_text_ready",
  "call_id": "call_fixture_incoming",
  "target_binding": "binding_fixture_2"
}
```

After speech-to-text completes, the app submits one final turn:

```json
{
  "type": "turn.submit",
  "operation_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "text": "Use the narrower release boundary.",
  "delivery": "steer"
}
```

Switchboard acknowledges the effective mode:

```json
{
  "type": "turn.accepted",
  "operation_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "response_id": "resp_fixture_1",
  "requested_delivery": "steer",
  "effective_delivery": "queue",
  "fallback_reason": "steer_not_supported",
  "target_binding": "binding_fixture_2"
}
```

Reply prose arrives in order:

```json
{"type":"reply.delta","response_id":"resp_fixture_1","sequence":1,"delta":"Use the narrower "}
```

```json
{"type":"reply.delta","response_id":"resp_fixture_1","sequence":2,"delta":"boundary first."}
```

```json
{
  "type": "reply.done",
  "response_id": "resp_fixture_1",
  "text": "Use the narrower boundary first.",
  "status": "completed"
}
```

The app displays these deltas as the current reply caption. It sends complete speakable segments to the backend speech endpoint in order. Tool output, reasoning and rich history do not appear on this channel.

A duplicate `turn.submit` with the same identifier and body returns recorded status. A changed text or delivery value returns `operation_conflict`. Never replay uncertain words under a new identifier.

## 4. Realtime transcription subset

The speech profile is `voicestack-mode-a-speech/1`. Its transcription side uses OpenAI GA Realtime event names as a strict subset. It is not a universal SDK-compatibility claim.

### 4.1 Transport and media

- Connect to the handout's `transcription_address`.
- Send `Authorization: Bearer <short-lived backend credential>`.
- JSON text frames carry events. Audio is base64 in JSON.
- Input is mono signed PCM16 little-endian at 24,000 Hz without a header.
- Each append contains at most 100 ms.
- The adapter converts to Parakeet's 16,000 Hz format statefully across chunks.
- One transcription turn can be in flight.
- There is no model response, output audio, tool call, replay or resume on this socket.

The first server event is `session.created`. Its session has `type:"transcription"`:

```json
{
  "event_id": "evt_rt_session",
  "type": "session.created",
  "session": {
    "id": "sess_fixture",
    "type": "transcription",
    "audio": {
      "input": {
        "format": {"type": "audio/pcm", "rate": 24000},
        "turn_detection": null,
        "transcription": {"model": "local-parakeet"}
      }
    }
  }
}
```

The app sends `session.update` with `session.type:"transcription"` and only these supported values. The adapter answers with `session.updated`, which carries the full effective configuration. Omitted fields keep their values. Invalid changes fail atomically. The app sends no audio until it has the effective `session.updated`.

Supported client events are:

- `session.update`;
- `input_audio_buffer.append`;
- `input_audio_buffer.commit`;
- `input_audio_buffer.clear`.

A minimal input is:

```json
{"event_id":"evt_c1","type":"input_audio_buffer.append","audio":"AAAAAA=="}
```

```json
{"event_id":"evt_c2","type":"input_audio_buffer.commit"}
```

The adapter emits:

```json
{
  "event_id": "evt_s1",
  "type": "input_audio_buffer.committed",
  "item_id": "item_user_1",
  "previous_item_id": null
}
```

```json
{
  "event_id": "evt_s2",
  "type": "conversation.item.input_audio_transcription.completed",
  "item_id": "item_user_1",
  "content_index": 0,
  "transcript": "Use the narrower release boundary.",
  "usage": {"type": "duration", "seconds": 1.4}
}
```

Parakeet's replacement partial snapshots are not sent as additive standard deltas. Clients that want live captions opt into the preview extension described in [INTEGRATION.md](INTEGRATION.md). The final event drives the user caption and the app's text-channel submission.

An abnormal Parakeet close emits `conversation.item.input_audio_transcription.failed`. It never becomes an empty success.

Realtime errors use:

```json
{
  "event_id": "evt_error_1",
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_feature",
    "message": "server VAD is not supported by voicestack-mode-a-speech/1",
    "param": "session.audio.input.turn_detection",
    "event_id": "evt_c_bad"
  }
}
```

Reject server VAD, semantic endpointing, automatic responses, output modalities, tools, function calls, arbitrary history, non-audio input, concurrent turns, provider model names, WebRTC, SIP and resume.

## 5. Text-to-speech subset

The app sends each speakable reply segment to the handout's `speech_address`.

Request:

```http
POST /v1/audio/speech
Authorization: Bearer <short-lived backend credential>
Content-Type: application/json
```

```json
{
  "model": "local-breeze",
  "voice": "local-default",
  "input": "Use the narrower boundary first.",
  "response_format": "pcm"
}
```

Supported values are:

- fixed model alias `local-breeze`;
- fixed voice alias `local-default`;
- non-empty UTF-8 input within the backend's advertised limit;
- `response_format` of `pcm` or `wav`.

`pcm` returns streamed headerless mono 24 kHz signed PCM16 little-endian audio. `wav` returns a valid WAV with the same media. The adapter validates Breeze output and never relabels another sample rate.

The app should request `pcm` for low-latency playback. It must serialize speech segments under one reply and discard late audio after call end or ownership loss.

The backend credential is accepted by both transcription and speech endpoints. The local adapter validates its signature, audience, profile, call binding and expiry with the configured Switchboard public key. This is offline verification, not a Switchboard call. For another backend, Switchboard returns a short-lived credential that backend accepts. The apps treat the value as opaque.

## 6. Speech backend readiness

The local adapter exposes two non-secret probes on its authenticated tailnet route:

`GET /health`:

```json
{"status":"ok"}
```

`GET /v1/capabilities`:

```json
{
  "profile": "voicestack-mode-a-speech/1",
  "transcription": {
    "transport": "openai-realtime",
    "input": {"type": "audio/pcm", "rate": 24000}
  },
  "speech": {
    "route": "/v1/audio/speech",
    "formats": ["pcm", "wav"],
    "output": {"type": "audio/pcm", "rate": 24000}
  },
  "models": ["local-parakeet", "local-breeze"],
  "voices": ["local-default"]
}
```

`status:"ok"` means both local services passed a bounded readiness check. The probe exposes no loopback addresses, model paths or credentials.
