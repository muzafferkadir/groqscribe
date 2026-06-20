#!/usr/bin/env bash
#
# groqscribe uninstaller
# Repo:  https://github.com/muzafferkadir/groqscribe
#
# One-line uninstall:
#   curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash
#
# Flags:
#   -y, --yes           skip the confirmation prompt
#   --keep-config       keep ~/.meet-groq-tr (your saved API key + usage stats)
#   -h, --help          show this help
#
# Reinstall any time:
#   curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash
#
set -euo pipefail

INSTALL_DIR="${GROQSCRIBE_DIR:-$HOME/.groqscribe}"
BIN_DIR="${GROQSCRIBE_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="groqscribe"
CONFIG_DIR="$HOME/.meet-groq-tr"   # API key + usage stats live here

# ---- pretty output (only when stdout is a TTY) ----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi
info() { printf '%s▸%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED"   "$C_RESET" "$*" >&2; exit 1; }

print_help() {
  cat <<'HELP'
groqscribe uninstaller

Usage:
  curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash

Flags:
  -y, --yes          skip the confirmation prompt
  --keep-config      keep ~/.meet-groq-tr (saved API key + usage stats)
  -h, --help         show this help

Environment overrides (match the installer):
  GROQSCRIBE_DIR         source clone location  (default: ~/.groqscribe)
  GROQSCRIBE_BIN_DIR     binary location        (default: ~/.local/bin)
HELP
}

# ---- parse args ----
ASSUME_YES=0
KEEP_CONFIG=0
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=1 ;;
    --keep-config) KEEP_CONFIG=1 ;;
    -h|--help) print_help; exit 0 ;;
    *) die "Unknown option: $a (try --help)" ;;
  esac
done

# ---- stop any running groqscribe (match the exact binary path, not the URL in a curl|bash line) ----
if command -v pgrep >/dev/null 2>&1 && pgrep -f "$BIN_DIR/$BIN_NAME" >/dev/null 2>&1; then
  warn "groqscribe is currently running. Stopping it..."
  pkill -f "$BIN_DIR/$BIN_NAME" 2>/dev/null || true
  sleep 1
fi

# ---- show the uninstall plan ----
echo
printf '%sUninstall plan:%s\n' "$C_BOLD" "$C_RESET"
[[ -x "$BIN_DIR/$BIN_NAME" ]] && printf '  • binary:        %s\n' "$BIN_DIR/$BIN_NAME"
[[ -d "$INSTALL_DIR" ]]       && printf '  • source clone:  %s\n' "$INSTALL_DIR"
if [[ "$KEEP_CONFIG" -eq 1 ]]; then
  [[ -d "$CONFIG_DIR" ]] && printf '  • config:        %s  (kept — --keep-config)\n' "$CONFIG_DIR"
else
  [[ -d "$CONFIG_DIR" ]] && printf '  • config:        %s  (API key + usage stats)\n' "$CONFIG_DIR"
fi
printf '  • PATH entry the installer added in your shell rc (if any)\n'
echo

# nothing to do?
if [[ ! -x "$BIN_DIR/$BIN_NAME" && ! -d "$INSTALL_DIR" && ! -d "$CONFIG_DIR" ]]; then
  ok "groqscribe is not installed — nothing to remove."
  exit 0
fi

# ---- confirm (read from the controlling terminal when stdin is piped, e.g. curl|bash) ----
if [[ "$ASSUME_YES" -ne 1 ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Proceed with uninstall? [y/N] " ans
  elif [[ -e /dev/tty ]]; then
    read -r -p "Proceed with uninstall? [y/N] " ans </dev/tty
  else
    die "No TTY available for confirmation. Re-run with -y to force uninstall."
  fi
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ---- remove binary ----
if [[ -x "$BIN_DIR/$BIN_NAME" ]]; then
  rm -f "$BIN_DIR/$BIN_NAME"
  ok "Removed binary: $BIN_DIR/$BIN_NAME"
fi

# ---- remove source clone ----
if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed source clone: $INSTALL_DIR"
fi

# ---- remove config (API key + usage stats), unless --keep-config ----
if [[ "$KEEP_CONFIG" -eq 1 ]]; then
  [[ -d "$CONFIG_DIR" ]] && info "Kept config: $CONFIG_DIR (--keep-config)"
else
  if [[ -d "$CONFIG_DIR" ]]; then
    rm -rf "$CONFIG_DIR"
    ok "Removed config: $CONFIG_DIR (API key + usage stats)"
  fi
fi

# ---- remove the installer's own PATH entries from shell rc files ----
# NOTE: ~/.local/bin is NOT removed from PATH — other tools may rely on it.
#       Only the "# Added by groqscribe installer" block is cleaned, and only
#       if it still references groqscribe's BIN_DIR.
clean_rc() {
  local profile="$1"
  [[ -f "$profile" ]] || return 0
  grep -q "# Added by groqscribe installer" "$profile" 2>/dev/null || return 0
  # only touch the block that points at *our* BIN_DIR (in case other tools
  # borrowed the same marker comment)
  grep -q "$BIN_DIR" "$profile" 2>/dev/null || return 0
  if command -v perl >/dev/null 2>&1; then
    perl -i -0pe 's/\n?# Added by groqscribe installer\n(?:export PATH[^\n]*|set -gx PATH[^\n]*)\n?//g' "$profile"
    ok "Cleaned PATH entry from $profile"
  else
    warn "Found a groqscribe PATH entry in $profile but perl is missing — remove the '# Added by groqscribe installer' block by hand."
  fi
}
for p in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.config/fish/config.fish" "$HOME/.profile"; do
  clean_rc "$p"
done

# ---- summary ----
echo
ok "${C_BOLD}groqscribe has been uninstalled.${C_RESET}"
echo
printf '  Reinstall any time with:\n'
printf '      curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash\n'
echo
