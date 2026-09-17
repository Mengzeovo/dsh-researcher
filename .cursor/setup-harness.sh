#!/usr/bin/env bash
#
# Cloud Agent install script for dsh-profile-researcher.
#
# This plugin is developed against the (unpublished) DeepSeek Harness workspace
# packages. package.json references them as absolute `link:` dependencies, and
# the committed pnpm lockfile resolves those links to `/Software/deepseek-harness`
# (and the optional Archify renderer to `/archify`). None of the required
# `@deepseek-ai/dsh-*@^0.1.5-rc.1` versions are published to npm, so the only way
# to obtain them is to check out the matching harness tag and build its libraries.
#
# Steps:
#   1. Select a Node runtime that satisfies the harness engine (>=22.19).
#   2. Clone deepseek-harness at the tag matching this plugin's peer range.
#   3. Build the harness host + client libraries (produces lib/ for every dep).
#   4. Install this plugin's dependencies (links resolve into the built harness).
#
# The script is idempotent: it can run again against a partially prepared tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_TAG="dsh-v0.1.5-rc.1"
HARNESS_DIR="/Software/deepseek-harness"
ARCHIFY_DIR="/archify/integrations/deepseek-harness-native"

log() { printf '\n\033[1;34m[setup]\033[0m %s\n' "$*"; }

# --- 1. Node runtime (harness requires ^22.19.0 || >=24) -------------------
ensure_node() {
  local current_major current_minor
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]')"
    current_minor="$(node -p 'process.versions.node.split(".")[1]')"
    if { [ "$current_major" -eq 22 ] && [ "$current_minor" -ge 19 ]; } || [ "$current_major" -ge 24 ]; then
      log "Using system Node $(node --version)"
      return 0
    fi
  fi

  log "Selecting Node >=22.19 via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if ! command -v nvm >/dev/null 2>&1; then
    echo "nvm is not available and system Node is too old (need >=22.19)." >&2
    exit 1
  fi
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
  log "Using Node $(node --version) via nvm"
}

ensure_node
corepack enable >/dev/null 2>&1 || true

# --- 2. Clone the harness at the matching tag ------------------------------
if [ ! -e /Software ]; then
  log "Creating /Software (requires sudo)"
  sudo mkdir -p /Software
  sudo chown "$(id -u):$(id -g)" /Software
fi

if [ ! -d "$HARNESS_DIR/.git" ]; then
  log "Cloning deepseek-harness@${HARNESS_TAG}"
  rm -rf "$HARNESS_DIR"
  git clone --depth 1 --branch "$HARNESS_TAG" \
    https://github.com/deepseek-ai/deepseek-harness.git "$HARNESS_DIR"
else
  log "Harness already present at ${HARNESS_DIR}"
fi

# --- 3. Build the harness libraries ---------------------------------------
log "Installing harness dependencies"
cd "$HARNESS_DIR"
corepack pnpm install

# tsdown (used by the harness build) needs its optional `unrun` peer to load
# its TypeScript config; it is not part of the harness lockfile closure.
if [ ! -d node_modules/unrun ]; then
  log "Adding tsdown's 'unrun' config loader"
  corepack pnpm add -D -w unrun
fi

log "Building harness host + client libraries (this is the slow step)"
corepack pnpm run build:lib

# --- 4. Install this plugin ------------------------------------------------
log "Installing dsh-profile-researcher dependencies"
cd "$REPO_ROOT"
corepack pnpm install

if [ ! -d "$ARCHIFY_DIR" ]; then
  cat >&2 <<'EOF'

[setup] NOTE: the private package `dsh-archify-native` was not found at
        /archify/integrations/deepseek-harness-native. The optional research
        "view" feature (src/view-*, src/client/view-*) cannot be type-checked,
        built, or fully tested without it. Everything else works. Provide that
        package at the path above to unlock the view feature.
EOF
fi

log "Done. Try: pnpm test | pnpm run typecheck | pnpm run build"
