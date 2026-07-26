# Local Moonshine dictation for pi

Offline, CPU-only speech-to-text dictation for pi. The Moonshine server is **off by default** and holds no RAM when stopped.

- `/tts on` — start the local Moonshine server.
- `/tts off` — cancel dictation if needed, stop the server, and release its RAM/VRAM.
- `/tts status` — show whether it is running.
- `alt+m` — start/stop recording (after `/tts on`).
- `alt+n` — cancel an in-progress recording/transcription.

The server is localhost-only, not enabled at login, and does not use remote inference.

Run `/reload` in pi after editing the extension.

## Install

```bash
pi install git:github.com/Federicocervelli/pi-dictate
```
