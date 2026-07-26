# Local Moonshine dictation for pi

Offline, CPU-only speech-to-text dictation for pi. The Moonshine server is **off by default** and holds no RAM when stopped.

- `/tts on` — start the local Moonshine server.
- `/tts off` — cancel dictation if needed, stop the server, and release its RAM/VRAM.
- `/tts status` — show whether it is running.
- `alt+m` — start/stop recording (after `/tts on`).
- `alt+n` — cancel an in-progress recording/transcription.

The server is localhost-only, not enabled at login, and does not use remote inference.

Run `/reload` in pi after editing the extension.

## Setup the local model

Installing this package installs only the Pi extension. The local CPU speech server and model are separate:

```bash
# Prerequisites: ffmpeg, PipeWire/PulseAudio, uv, and Python 3.10+
mkdir -p ~/.local/share/whisperx/.venv
uv venv --python 3.10 ~/.local/share/whisperx/.venv
uv pip install --python ~/.local/share/whisperx/.venv/bin/python moonshine-voice
```

This extension uses **Moonshine Medium Streaming English** (245M parameters), a quantized ONNX model running on the CPU. Start the service once to download/cache the model and verify it:

```bash
systemctl --user daemon-reload
systemctl --user start pi-dictate.service
curl -fsS http://127.0.0.1:8765/health
```

The model is cached under `~/.cache/moonshine_voice/`. The server listens only on localhost and uses no API key or remote inference. Audio is processed in chunks while recording, but text is inserted only after the second `Alt+M`, so cancelling does not leave partial text behind. In Pi, `/tts on`, `/tts off`, and `/tts status` control the service.

### Agent setup checklist

An agent setting up this extension should install `moonshine-voice`, ensure `~/.local/share/whisperx/pi-dictate-server.py` and `~/.config/systemd/user/pi-dictate.service` exist, start the service, and check `/health` before testing `Alt+M`.

## Install

```bash
pi install git:github.com/Federicocervelli/pi-dictate
```
