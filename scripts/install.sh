#!/usr/bin/env bash
#
# groqscribe installer
# Repo:  https://github.com/muzafferkadir/groqscribe
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash
#
# Re-running this script updates groqscribe in place.
#
set -euo pipefail

REPO="https://github.com/muzafferkadir/groqscribe.git"
INSTALL_DIR="${GROQSCRIBE_DIR:-$HOME/.groqscribe}"
BIN_DIR="${GROQSCRIBE_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="groqscribe"

# ---- pretty output (only when stdout is a TTY) ----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info() { printf '%s▸%s %s\n'  "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n'  "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }

# ---- detect OS ----
OS="$(uname -s)"
case "$OS" in
  Darwin) MACOS=1 ;;
  Linux)  MACOS=0 ;;
  *) die "Unsupported OS: $OS (only macOS and Linux are supported)." ;;
esac

# ---- git ----
command -v git >/dev/null 2>&1 || die "git not found. Install Git first: https://git-scm.com/downloads"

# ---- Node.js 20+ ----
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$NODE_MAJOR" -ge 20 ]] && NODE_OK=1
fi
if [[ "$NODE_OK" -ne 1 ]]; then
  die "Node.js 20+ is required but was not found.
       Install it from https://nodejs.org or via nvm:
         curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
         nvm install 20"
fi

# ---- ffmpeg (needed for mic / system-audio capture) ----
if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg not found — required for microphone & system-audio capture."
  if [[ "$MACOS" -eq 1 ]]; then
    if command -v brew >/dev/null 2>&1; then
      info "Installing ffmpeg via Homebrew..."
      brew install ffmpeg || warn "ffmpeg install failed — finish it manually: brew install ffmpeg"
    else
      warn "Install Homebrew first (https://brew.sh), then: brew install ffmpeg"
    fi
  else
    warn "Install ffmpeg with your package manager, e.g.:
        sudo apt install ffmpeg   # Debian/Ubuntu
        sudo dnf install ffmpeg   # Fedora
        sudo pacman -S ffmpeg     # Arch"
  fi
fi

# ---- Swift toolchain (macOS only — builds the native system-audio helper) ----
if [[ "$MACOS" -eq 1 ]] && ! command -v swiftc >/dev/null 2>&1; then
  warn "swiftc not found — installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  warn "After the Command Line Tools finish, re-run this installer to enable system-audio capture.
        (Microphone-only mode works without it.)"
fi

# ---- clone or update ----
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing groqscribe at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet --prune
  git -C "$INSTALL_DIR" reset --quiet --hard "origin/$(git -C "$INSTALL_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)" \
    || git -C "$INSTALL_DIR" pull --quiet --ff-only
else
  info "Cloning groqscribe into $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---- Node dependencies ----
info "Installing Node dependencies..."
npm install --no-fund --no-audit --quiet

# ---- macOS native system-audio helper ----
if [[ "$MACOS" -eq 1 ]] && command -v swiftc >/dev/null 2>&1; then
  info "Building macOS system-audio helper (Swift)..."
  if bash scripts/build-system-audio-helper.sh >/dev/null 2>&1; then
    ok "System-audio helper built."
  else
    warn "System-audio helper build failed — microphone-only mode still works."
  fi
fi

# ---- bundle the single-file executable ----
info "Bundling single-file executable..."
npm run build:executable >/dev/null
[[ -x "$INSTALL_DIR/dist/groqscribe" ]] || die "Build failed: dist/groqscribe not produced."

# ---- install into ~/.local/bin ----
mkdir -p "$BIN_DIR"
cp -f "$INSTALL_DIR/dist/groqscribe" "$BIN_DIR/$BIN_NAME"
chmod +x "$BIN_DIR/$BIN_NAME"
ok "Installed $BIN_NAME → $BIN_DIR/$BIN_NAME"

# ---- make sure $BIN_DIR is on PATH ----
PATH_UPDATED=0
ensure_path() {
  local profile="$1"
  [[ -f "$profile" ]] || touch "$profile"
  if ! grep -q "$BIN_DIR" "$profile" 2>/dev/null; then
    # shellcheck disable=SC2016  # $PATH must be written literally into the profile
    printf '\n# Added by groqscribe installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$profile"
    PATH_UPDATED=1
  fi
}
case "$(basename "${SHELL:-sh}")" in
  zsh)  ensure_path "$HOME/.zshrc" ;;
  bash) ensure_path "$HOME/.bashrc" ;;
  fish)
    mkdir -p "$HOME/.config/fish"
    if ! grep -q "$BIN_DIR" "$HOME/.config/fish/config.fish" 2>/dev/null; then
      # shellcheck disable=SC2016  # $PATH must be written literally into the fish config
      printf '\n# Added by groqscribe installer\nset -gx PATH %s $PATH\n' "$BIN_DIR" >> "$HOME/.config/fish/config.fish"
      PATH_UPDATED=1
    fi ;;
  *) ensure_path "$HOME/.profile" ;;
esac

# ---- summary ----
echo
ok "${C_BOLD}groqscribe is ready!${C_RESET}"
echo
printf '  Get a free Groq API key: https://console.groq.com/keys\n\n'
if [[ "$MACOS" -eq 1 ]]; then
  printf '  On first run it prompts for your API key, or set it now:\n'
  printf '      export GROQ_API_KEY="gsk_..."\n\n'
  printf '  Grant "Screen & System Audio Recording" permission to your terminal\n'
  printf '  for system-audio capture (microphone works without it).\n\n'
else
  printf '  Set your Groq API key:\n      export GROQ_API_KEY="gsk_..."\n\n'
fi
if [[ "$PATH_UPDATED" -eq 1 ]]; then
  warn "Added $BIN_DIR to your PATH — restart your terminal (or: source ~/.zshrc), then:"
else
  printf '  Now run:\n'
fi
printf '      %sgroqscribe%s\n' "$C_BOLD" "$C_RESET"
echo
