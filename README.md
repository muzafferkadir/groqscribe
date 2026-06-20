# groqscribe

Terminal app for live microphone and system audio transcription with Groq Whisper.

## Requirements

- Node.js 20+
- A Groq API key
- `ffmpeg` (for microphone capture and virtual-device fallback)
- macOS system audio: Screen & System Audio Recording permission

## Install

```bash
npm install
npm run build-system-audio-helper   # macOS only, for native system audio
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
