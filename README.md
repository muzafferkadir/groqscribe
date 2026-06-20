# groqscribe

Terminal app for live microphone and system audio transcription with Groq Whisper.

## Requirements

- Node.js 20+
- A Groq API key
- `ffmpeg` (for microphone capture and virtual-device fallback)
- macOS system audio: Screen & System Audio Recording permission

## Install

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash
```

This clones the repo, installs Node dependencies, builds the macOS system-audio
helper (if you're on macOS), bundles the single-file executable, and installs it
as `groqscribe` in `~/.local/bin` (added to your `PATH` automatically). Re-run
the same command to update.

Requires Node.js 20+ and `git`; `ffmpeg` is needed for audio capture (the
installer will try to install it via Homebrew on macOS). On macOS, system-audio
capture also needs the Xcode Command Line Tools (`swiftc`).

### Manual install (from source)

```bash
git clone https://github.com/muzafferkadir/groqscribe.git
cd groqscribe
npm install
npm run build-system-audio-helper   # macOS only, for native system audio
npm run build:executable
cp dist/groqscribe ~/.local/bin/groqscribe
```

## Run

```bash
npm start
```

On first run, if no API key is found, it prompts and saves it to `~/.meet-groq-tr/config.json`.

## Examples

```bash
npm start -- --language en
npm start -- --no-mic
npm start -- --no-system-audio
npm start -- --translate --target-language en
npm start -- --list-devices
```

## Hotkeys

- `Space` pause/resume
- `M` microphone
- `B` system audio
- `L` cycle Whisper language
- `R` restart
- `S` settings panel
- `O` original text
- `Q` quit

## Single-file executable

```bash
npm run build:executable
./dist/groqscribe

# install globally
cp dist/groqscribe ~/.local/bin/groqscribe
```

## macOS system audio

Grant **Screen & System Audio Recording** permission to your terminal, or use a virtual fallback:

```bash
npm start -- --system-backend virtual
npm run setup-macos-audio
```

## Test

```bash
npm test
```
