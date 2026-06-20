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

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash
```

Removes the `groqscribe` binary, the `~/.groqscribe` source clone, and the
`~/.meet-groq-tr` config (including your saved API key). It only cleans the
`PATH` entry that this installer added — other tools sharing `~/.local/bin`
are left untouched. It asks for confirmation first; to skip it, append `-y`:

```bash
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash -s -- -y
```

To keep your saved API key and usage stats (so a reinstall doesn't re-prompt),
add `--keep-config`:

```bash
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash -s -- -y --keep-config
```

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

On first run, if no API key is found, it prompts and saves it to `~/.meet-groq-tr/config.json` (get one at https://console.groq.com/keys).

By default **only system audio** is captured (microphone is off) to avoid
double-capturing the same sound through both sources. Enable the mic with
`--mic` or press `M` at runtime; toggle system audio with `B`.

## Examples

```bash
npm start -- --language en
npm start -- --mic                  # capture microphone instead of system audio
npm start -- --no-system-audio      # disable system audio (press M to add mic)
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
- `L` cycle source (Whisper) language
- `G` cycle target language (used when translation is on)
- `T` toggle chat translation (off by default)
- `↑` / `↓` scroll transcript (PgUp/PgDn by 10); return to live with `↓`
- `Q` quit

Translation is off by default — toggle it at runtime with `T` (or start with
`--translate`). The sidebar's LANGUAGES group shows the active source/target
language and the translation state.

The header shows a blinking red `●` next to each source (`MIC`/`SYS`) while it is
actively capturing. On first run, if no API key is found, it prompts and saves
it to `~/.meet-groq-tr/config.json` (get a key at
https://console.groq.com/keys).

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
