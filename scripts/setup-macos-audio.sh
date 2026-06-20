#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS."
  exit 1
fi

cat <<'MSG'
macOS does not expose speaker/system output as a plain CLI audio input.
The most stable free fallback is the BlackHole virtual audio driver.

This script helps install BlackHole 2ch.
MSG

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew was not found. Install Homebrew first: https://brew.sh"
  exit 1
fi

if brew list --cask blackhole-2ch >/dev/null 2>&1; then
  echo "BlackHole 2ch is already installed."
else
  echo "Installing BlackHole 2ch..."
  brew install --cask blackhole-2ch
fi

cat <<'MSG'

Next steps:
1. Open Audio MIDI Setup.
2. Click + in the lower-left and choose Create Multi-Output Device.
3. Select both your normal speaker/headphones and BlackHole 2ch.
4. Set macOS Sound Output to that Multi-Output Device.
5. Verify the device list:
   npm run list-devices
6. Capture system audio:
   export GROQ_API_KEY="gsk_..."
   npm run cli:system

BlackHole is not required for microphone/ambient audio:
   npm run cli:mic
MSG
