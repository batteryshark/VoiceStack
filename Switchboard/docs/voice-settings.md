# Voice profiles and the settings page

Switchboard owns the list of speech backends ("profiles"), their addresses, the selected voice and which profile new
calls use. The apps have no backend picker; they can only choose a voice within the active profile.

## What a call keeps

When a call starts (ringing included) Switchboard snapshots its backend, voice and models. Changing the default,
editing a profile, deleting an inactive profile or renewing a handout cannot redirect a call that already exists.
There is no live-call migration and no automatic fallback to another provider. Restarting Switchboard ends calls.

For a local backend, audio still goes directly between the app and the speech adapter. The handout credential
carries an optional signed `voice` claim, so the adapter uses the call's voice even if the shared choice changes
later.

## The settings page

`/settings` on the server's own HTTP port is a small browser page for adding, editing, checking and selecting
profiles. It uses the same SQLite database as everything else.

- Set the password by piping it to `bin/switchboard admin-password --config FILE`. Only a hash is stored.
- A login lasts eight hours or until the server restarts.
- "Check connection" reads the backend's voice catalog, or the cloud provider's model list. It does not synthesize
  audio or load models.

From the apps, a paired device reads and changes the shared voice with `GET` and `PUT /settings/speech`, and can ask
for a short sample with `POST /settings/speech/preview`. Voice management requests from Switchboard to the adapter
use a separate short-lived signature bound to the method and path; a caller token or a call credential cannot
administer voices.

## Cloud profile (OpenAI)

A profile with provider `openai` routes speech through a small bridge inside Switchboard, so the API key stays on
the server. The app's PCM transcription protocol is mapped to OpenAI's realtime transcription session, and speech
requests return 24 kHz PCM. The key is stored as a mode-600 file beside the database and is never returned to the
browser or a device. Default models and voice are editable in the profile.

This path has only been run against a fake transport in the tests. It has never made a real request to OpenAI, so
audio quality, latency and model access are unverified. With this profile, audio and the text to be spoken leave
your network.
