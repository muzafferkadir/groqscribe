# groqscribe

Live terminal transcription of your microphone and system audio using Groq Whisper.

## Requirements

- **Node.js 20+** and `git`
- **ffmpeg** — for audio capture (the installer installs it via Homebrew on macOS if missing)
- **macOS only** — Xcode Command Line Tools (`swiftc`) for system-audio capture, plus the *Screen & System Audio Recording* permission for your terminal

The one-line installer checks all of these automatically and tries to install what's missing.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash
```

Re-run the same command to update. It clones the repo, installs dependencies, builds the macOS system-audio helper, bundles the executable, and installs `groqscribe` into `~/.local/bin` (added to your `PATH`).

### Uninstall

```bash
groqscribe --uninstall                 # prompts for confirmation
groqscribe --uninstall -y              # no prompt
groqscribe --uninstall --keep-config   # keep your saved API key
```

Or via curl: `curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash`

## Usage

```bash
groqscribe                  # default: system audio only (avoids double-capturing sound through the mic)
groqscribe --mic            # capture microphone instead of system audio
groqscribe --translate      # enable chat translation (target language: en)
```

By default only **system audio** is captured; the microphone is off so the same sound isn't transcribed twice. Enable the mic with `--mic` or press `M` at runtime.

## API key

Get a free key at **https://console.groq.com/keys**.

On first run, `groqscribe` prompts for it and saves it to `~/.config/groqscribe/config.json`. Or set it before running:

```bash
export GROQ_API_KEY="gsk_..."
```

Precedence: `--api-key` → `GROQ_API_KEY` → saved config → interactive prompt.

## Shortcuts

| Key | Action |
|-----|--------|
| `Space` | pause / resume |
| `M` | toggle microphone |
| `B` | toggle system audio |
| `T` | toggle translation (off by default) |
| `L` | cycle source (Whisper) language |
| `G` | cycle target language |
| `R` | restart |
| `S` | toggle settings panel |
| `O` | toggle original text |
| `↑` / `↓` | scroll transcript (PgUp/PgDn by 10); `↓` returns to live |
| `Q` | quit |

A blinking red `●` appears next to each active source (`MIC`/`SYS`) in the header while capturing.

## Options

| Option | Description |
|--------|-------------|
| `--mic` | capture microphone instead of system audio |
| `--no-system-audio` | disable system audio (press `M` to add mic) |
| `--language <code>` | Whisper source language; `auto` or ISO code (`en`, `tr`, `de`…) |
| `--translate` | enable chat translation |
| `--target-language <code>` | target language for translation (default `en`) |
| `--reset-api-key` | ignore env/config and prompt for a new API key |
| `--no-save-api-key` | don't save a prompted API key |
| `--list-devices` | list available audio devices |
| `--long-segment-ms` / `--long-segment-silence-ms` | tuning |
| `--uninstall` | remove groqscribe and its config (`-y`, `--keep-config`) |
| `--help` | show help |

Transcript is written to `transcription_<ss>_<hh>_<DD>_<MM>_<YY>.txt` in the current directory — one file per run, never overwriting. Override with `--output <file>`.

---

## Development

### Manual install (from source)

```bash
git clone https://github.com/muzafferkadir/groqscribe.git
cd groqscribe
npm install
npm run build-system-audio-helper   # macOS only, for native system audio
npm run build:executable
cp dist/groqscribe ~/.local/bin/groqscribe
```

### Build the single-file executable

```bash
npm run build:executable
./dist/groqscribe
```

### macOS system audio

Grant **Screen & System Audio Recording** permission to your terminal. If capture fails, use the virtual audio fallback:

```bash
npm run setup-macos-audio          # installs BlackHole 2ch via Homebrew
groqscribe --system-backend virtual
```

### Test

```bash
npm test
```
