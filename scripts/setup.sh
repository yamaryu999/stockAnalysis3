#!/usr/bin/env bash
set -euo pipefail

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${BLUE}[setup]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

# 1) Install NVM if missing
if [ ! -d "$HOME/.nvm" ]; then
  log "Installing NVM..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
else
  log "NVM already installed."
fi

# Load NVM for this script
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1090
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# 2) Install Node.js LTS (v20)
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js v20 via nvm..."
  nvm install 20
else
  log "Node.js already present: $(node -v)"
fi

log "Using Node: $(node -v)"

# 3) Backend dependencies
log "Installing backend dependencies..."
cd "$(dirname "$0")/../backend"
npm install
success "Backend dependencies installed."

echo
success "Setup completed. To start the server:"
echo "  bash scripts/start.sh"
