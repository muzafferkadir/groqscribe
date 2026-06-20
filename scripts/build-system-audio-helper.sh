#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The system audio helper can only be built on macOS."
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/bin"

swiftc \
  -O \
  -parse-as-library \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  "$ROOT/native/SystemAudioCapture.swift" \
  -o "$ROOT/bin/system-audio-capture"

chmod +x "$ROOT/bin/system-audio-capture"
echo "$ROOT/bin/system-audio-capture"
