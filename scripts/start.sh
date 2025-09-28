#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1090
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# Use Node 20 if available
if command -v nvm >/dev/null 2>&1; then
  nvm use 20 >/dev/null 2>&1 || true
fi
cd "$(dirname "$0")/../backend"
npm start
