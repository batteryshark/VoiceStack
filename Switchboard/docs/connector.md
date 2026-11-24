# Connector: the call tool and the relay

The connector is the half of Switchboard that faces the agent. It has two commands. `call` lets an agent ring you.
`relay` carries each call's text turns into the agent conversation and brings the reply back.

## The call tool

An agent rings you with one shell command:

```sh
switchboard-connector call --subject "Need to settle the release boundary"
```

- It reads the caller token through one lookup (`src/connector/secrets.ts`): a file named in the connector config.
  The file must not be accessible to others (`chmod 600`, or `640` with a service group). Otherwise the command refuses.
- It sends `POST /calls` with `direction: incoming`, the subject and a fresh `operation_id`. The token fixes the
  caller name; the request carries no name, target or backend. A subject is 1 to 60 characters after trimming.
- It prints JSON: `operation_id` and `call` (`id`, `state: ringing`, `caller_name`, `subject`, `ring_expires_at`).
  It never prints the token.
- Exit codes: `0` rang, or replayed a recorded call. `2` refused, with the contract error in the output:
  `token_revoked`, `validation_error`, `target_unavailable`, `backend_unavailable`, `operation_conflict`.
  `3` uncertain: Switchboard did not answer. Rerun with `--operation-id <the printed id>`, never with a new one.
- Answering puts the call into the default target's conversation. Your spoken turns arrive there as prompts with a
  voice prefix, and the reply text is what you hear.

Config (`$SWITCHBOARD_CONNECTOR_CONFIG`, `--config FILE`, or `~/.config/switchboard/connector.json`):

```json
{
  "switchboard": "http://127.0.0.1:47860",
  "caller_token": { "file": "/etc/switchboard/agent-caller-token" }
}
```

You create the token in either app (it shows the secret once) and put it in that file yourself. The tool never
prints it, but any process running as the file's owner can read it.

A line like this in the agent's instructions is enough for it to use the tool: *"To ring the user, run
`switchboard-connector call --subject "<60 characters or fewer>"`. Exit 0 means it is ringing; 2 means refused (read
the error code); 3 means uncertain (rerun with the printed `--operation-id`). Spoken turns arrive prefixed
`[voice]`; answer them in short speakable prose."*

## The relay

`switchboard-connector relay` keeps one WebSocket to Switchboard ([protocol](connector-protocol.md)). When a call
starts it asks its lane to pin the target to one conversation, and the call stays on that conversation. Each turn
goes to the lane in order, and the lane's reply text streams back.

```json
{
  "switchboard": "http://127.0.0.1:47860",
  "connector_credential": { "file": "/etc/switchboard/connector-credential" },
  "lane": {
    "kind": "native",
    "instance": "/etc/switchboard/session-server.json",
    "targets": { "target_main": "default" }
  }
}
```

## Lanes

A lane is where calls land. The interface is in `src/connector/lanes.ts`: `targets`, `resolve` (pin a target at
call start), `deliver` (one turn in, the speakable reply out), and optionally `catalog` and `ended`.

Two lanes are in the repository:

- **`ScriptedLane`** returns fixed replies. The tests use it.
- **`native`** (`src/connector/native-lane.ts`) talks to an agent session server over HTTP. It reads a small JSON
  file on every use: `{ "base": "http://127.0.0.1:PORT", "runtimePassword": "...", "defaultSession": "ses_..." }`,
  and authenticates with HTTP Basic auth as user `opencode`. A target maps to a session id, or to `default` for
  the file's current `defaultSession`. For each turn it:
  1. refuses if the pinned session is no longer what the target resolves to, so a turn never lands somewhere else;
  2. posts the turn as a queued prompt whose message id is derived from the call and operation ids, so a repeat is
     the same message;
  3. waits for the session to go idle and returns the last completed assistant text after that message. Tool
     output and reasoning are not part of it.

  Its catalog lists the other unarchived sessions, labelled by title and project directory, so the apps can dial a
  specific session. It cannot steer a running turn, so a requested Steer is answered as Queue.

The `native` lane was written against the session routes of the agent runtime I run (`/api/session/...` and
`/api/experimental/session/ID/wait`). I have not tested it against any other server. To use Switchboard with a
different agent, write a lane for it; nothing else in the server knows what is on the other side.

## Running it

Nothing here installs itself. The pieces are:

1. **Server.** `bin/switchboard serve --config FILE` listens on loopback (default `127.0.0.1:47860`). Put TLS in
   front of it on a private network, for example `tailscale serve --https=9450 http://127.0.0.1:47860`, and set
   `public_base` to that address plus `/voicestack/v1`. State is one SQLite file and one signing key.
2. **Backends.** List each speech backend in `backends`. Give each adapter the output of `switchboard backend key`,
   the public key it verifies handout credentials with. `switchboard backend use ID` switches the active one with
   no app change.
3. **Relay.** `switchboard connector-credential NAME` prints a credential once. Store it in a protected file and
   run `switchboard-connector relay`.
4. **Pairing.** `switchboard pairing-code` prints a one-use code. Type it into each app.
5. **Push.** `push.kind` is `off`, or `stub` for tests. Real APNs is not implemented: it needs a sender that speaks
   HTTP/2 to Apple with a provider token, behind the existing `PushSender` interface.
6. **Check.** `bun scripts/verify-install.ts` pairs a stub device, places a call through the real call command,
   answers it and relays one turn. It sends one real message to the default target.
