# Connector protocol (internal)

Between Switchboard and the connector relay on the same host. It is not part of the app contract and can change
with both sides in this repository. A WebSocket at `ws://127.0.0.1:<port>/connector/v1/stream` carries JSON text
frames. The connector authenticates with `Authorization: Bearer <connector credential>`, made by
`switchboard connector-credential NAME`. The newest connector to say hello is the one Switchboard uses.

| Direction | Frame | Meaning |
|---|---|---|
| connector → | `{"type":"connector.hello","version","steer":bool,"catalog":bool,"targets":[ids]}` | What the connector serves, whether its lane can steer, and whether it can list more conversations. |
| → connector | `{"type":"connector.ready","targets":[ids]}` | The configured targets this connector serves. They now show `available: true`. |
| → connector | `{"type":"catalog.request","request_id"}` | List the other conversations a device may dial, for `GET /targets`. |
| connector → | `{"type":"catalog.result","request_id","targets":[{"id","label","project"}]}` or `{"error":true}` | The lane's catalog. |
| → connector | `{"type":"bind.request","request_id","call_id","target_id"}` | Prepare and pin the target before a ring or dial-in (15 s). |
| connector → | `{"type":"bind.result","request_id","ok":true,"lane_ref"}` or `{"ok":false,"reason"}` | `lane_ref` is opaque to Switchboard, kept on the call and never shown to apps. |
| → connector | `{"type":"call.accepted","call_id"}` | An incoming call was answered. |
| → connector | `{"type":"turn","call_id","lane_ref","target_id","response_id","operation_id","text","delivery"}` | One final user turn, with its effective delivery. |
| connector → | `{"type":"reply.delta","response_id","delta"}` | Speakable reply text, in order. Switchboard numbers the sequence. |
| connector → | `{"type":"reply.done","response_id","status":"completed"|"failed","text"?}` | End of the reply. |
| connector → | `{"type":"call.end","call_id"}` | The caller hangs up; devices get `call.ended` with reason `caller`. |
| → connector | `{"type":"call.ended","call_id","reason"}` | The call is over. |

The relay delivers one call's turns strictly in order. The lane derives its message id from the call id and the
turn's `operation_id`, so a repeated delivery is the same input, not a second message.
