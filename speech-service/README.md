# BB speech service

Small GPU service for the BB voice proof of concept. It keeps one Parakeet STT
model and one Qwen3-TTS model warm, with one request lock per model.

## Proven matrix

This exact matrix passed both GPU smoke tests on `rdlegion` on 2026-08-14.

| Part | Version |
| --- | --- |
| Host | `rdlegion` WSL2 Ubuntu 26.04, RTX 5090 Laptop GPU, driver 610.88 |
| Python / uv | 3.12.13 / 0.12.4 |
| PyTorch | 2.12.1+cu130, CUDA runtime 13.0 |
| STT | `nano-parakeet` 0.2.1, `nvidia/parakeet-tdt-0.6b-v3` |
| TTS | `faster-qwen3-tts` 0.3.2, `qwen-tts` 0.1.1, `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` |
| TTS backend | Torch CUDA graphs, bfloat16 |
| Voice | Aiden |
| API / audio | FastAPI 0.141.1, Uvicorn 0.52.3, SoundFile 0.14.0, FFmpeg 8.0.1 |

The machine needs about 13 GiB of free GPU memory. Startup is deliberately
fatal if CUDA is missing or a model cannot load, including an out-of-memory
error.

## Install on rdlegion

Run from this repository on `srv1191956`:

```bash
tar -C speech-service -czf - . | ssh rdlegion \
  "wsl.exe -d Ubuntu -- bash -lc 'mkdir -p /home/ratul/bb-speech-service && tar -xzf - -C /home/ratul/bb-speech-service'"
```

Then enter WSL and install the system and Python dependencies:

```powershell
ssh rdlegion
wsl.exe -d Ubuntu
```

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg curl
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv python install 3.12
cd /home/ratul/bb-speech-service
~/.local/bin/uv sync --frozen
```

The project and model caches stay in the WSL filesystem, not under `/mnt/c`.

## Test and start

The smoke tests load both models once, transcribe a real short WAV, and create
a decodable WAV at the TTS model's native sample rate:

```bash
cd /home/ratul/bb-speech-service
~/.local/bin/uv run --frozen pytest test_smoke.py
```

Start the manual POC service as a transient user unit:

```bash
systemd-run --user --unit=bb-speech-service --collect \
  --property=WorkingDirectory=/home/ratul/bb-speech-service \
  /home/ratul/.local/bin/uv run --frozen \
  uvicorn app:app --host 127.0.0.1 --port 18077
journalctl --user -fu bb-speech-service
```

On the Windows side, expose only port 18077 through Tailscale:

```powershell
tailscale serve --bg --tcp=18077 tcp://localhost:18077
tailscale serve status
```

## Verify

From a Tailscale peer, replace the host only if its Tailscale address changes:

```bash
curl --fail --show-error --write-out '\nwall=%{time_total}s\n' \
  http://100.81.193.12:18077/health

curl --fail --show-error --write-out '\nwall=%{time_total}s\n' \
  -F file=@speech-service/smoke.wav \
  http://100.81.193.12:18077/v1/audio/transcriptions

curl --fail --show-error \
  --write-out 'wall=%{time_total}s bytes=%{size_download}\n' \
  -H 'Content-Type: application/json' \
  -d '{"input":"The BB voice proof is ready.","voice":"Aiden"}' \
  http://100.81.193.12:18077/v1/audio/speech \
  --output /tmp/bb-speech.wav

ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,duration \
  -of default=noprint_wrappers=1 /tmp/bb-speech.wav
```

The proof run from `srv1191956` returned health in 0.054 seconds, the transcript
`The voice service smoke test is working.` in 0.204 seconds, and an 80,684-byte,
24 kHz mono WAV in 3.779 seconds.

Accepted transcription uploads are WebM, MP4, Ogg, and WAV, up to 25 MB and
90 seconds. Speech input is capped at 8,000 characters and only the `Aiden`
voice is enabled. Generated speech stays at the model's native sample rate.
