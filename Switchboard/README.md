# Switchboard

VoiceStack's call server and its connector CLI. It runs on the machine where your agent runs.

- **Server** (`bin/switchboard serve`): the `voicestack-app/1` contract in
  [`../Docs/PROTOCOL.md`](../Docs/PROTOCOL.md): pairing, caller tokens, targets, calls, incoming-call signals
  (device events and VoIP push), accept/decline/end, backend handouts and the per-call text channel. It listens on
  loopback and expects TLS in front of it on a private network (`tailscale serve` is what I use).
- **Connector** (`bin/switchboard-connector`): `call` is the tool an agent uses to ring you; `relay` carries each
  call's text turns into the pinned agent conversation and streams the reply back.

Audio never passes through Switchboard. Apps send audio to the active speech backend, which Switchboard chooses and
hands out per call with a short-lived Ed25519-signed credential that the backend verifies offline.

```text
app ──turn.submit──▶ Switchboard ──turn──▶ connector relay ──lane──▶ agent conversation
app ◀─reply.delta/done── Switchboard ◀─reply.delta/done── relay ◀── reply (speakable text only)
```

## Run

Needs [Bun](https://bun.sh) (written against 1.4). No dependencies.

```sh
bun test                                   # contract fixtures, edge cases, call command, lanes, voice settings
bun scripts/extract-fixtures.ts --check    # fixtures still equal the contract document
bin/switchboard serve --config config/switchboard.json
bin/switchboard pairing-code --config config/switchboard.json
bin/switchboard-connector call --subject "Need to settle the release boundary" --config config/connector.json
```

Example configs: [`config/switchboard.example.json`](config/switchboard.example.json),
[`config/connector.example.json`](config/connector.example.json). `bin/switchboard` with no command lists the
administration subcommands (pairing codes, connector credentials, backends, call records, devices, tokens).

## Layout

| Path | What |
|---|---|
| `src/server/app.ts` | HTTP and WebSocket routes, call lifecycle, text channel, connector stream |
| `src/server/store.ts` | SQLite records; every secret only as sha256 |
| `src/server/backend.ts` | Backend handout credentials (sign, verify) and readiness probe |
| `src/server/profiles.ts`, `settings-api.ts`, `settings-page.ts` | Voice profiles and the `/settings` page |
| `src/server/cloud-speech.ts` | Optional OpenAI speech bridge (tested against a fake transport only) |
| `src/server/push.ts` | VoIP push in APNs request shape; stub transport only |
| `src/connector/cli.ts` | `call` and `relay` |
| `src/connector/lanes.ts`, `native-lane.ts` | The lane interface, a scripted lane for tests, and the HTTP session-server lane |
| `src/connector/secrets.ts` | The one secret lookup (a protected file) |
| `src/stubs/` | APNs stub, stub iPhone and Mac, used by the tests |
| `scripts/verify-install.ts` | End-to-end check of an installed instance |
| `test/fixtures/contract/` | All 32 JSON examples of PROTOCOL.md sections 2 and 3, verbatim |
| `docs/` | [Connector, lanes and running it](docs/connector.md), [connector protocol](docs/connector-protocol.md), [values the contract leaves open](docs/contract-notes.md), [voice profiles](docs/voice-settings.md) |

## How the contract is tested

`test/contract.test.ts` drives the real server with the fixture requests verbatim and checks every response and
event with `test/conform.ts`: the same keys at every level (none missing, none extra), the same JSON types, equal
constants, and generated ids that keep their prefix and stay consistent across the scenario (so `text_channel` must
name the real call). `test/fixtures.test.ts` fails if a fixture drifts from the document, and proves the matcher
rejects missing, extra, mistyped and changed fields.

## Security

- Private network only: the server binds loopback, and TLS ends at whatever you put in front of it. It is not
  meant for a public address.
- Secrets are stored hashed: pairing codes, device credentials, caller tokens and connector credentials are kept as
  sha256 only. A caller token's secret appears once, in its creation response. Backend credentials are never recorded.
- A caller token can only `POST /calls` with `direction: incoming`. Every other route refuses it with `forbidden`. A
  revoked token is refused with `token_revoked`, and a call it already placed continues.
- Call records hold ids, states, routes, outcomes and character counts. They never hold credentials, audio or the
  words of a turn; the words live in the conversation.
- Real APNs is not wired: `push.kind` is `stub` or `off`.
