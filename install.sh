#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Docker Dash — One-Command Installer
#  Usage: curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── Detect OS & Architecture ────────────────────────────────
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux*)  OS_NAME="Linux" ;;
    Darwin*) OS_NAME="macOS" ;;
    *)       fail "Unsupported OS: $OS. This script supports Linux and macOS." ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   ARCH_NAME="amd64" ;;
    aarch64|arm64)   ARCH_NAME="arm64" ;;
    *)               fail "Unsupported architecture: $ARCH. This script supports amd64 and arm64." ;;
  esac

  ok "Detected platform: $OS_NAME ($ARCH_NAME)"
}

# ── Check Docker ────────────────────────────────────────────
check_docker() {
  if ! command -v docker &>/dev/null; then
    warn "Docker is not installed."
    echo ""
    echo "  Install Docker:"
    case "$OS_NAME" in
      Linux)
        echo "    curl -fsSL https://get.docker.com | sh"
        echo "    sudo usermod -aG docker \$USER"
        echo "    # Log out and back in, then re-run this script"
        ;;
      macOS)
        echo "    brew install --cask docker"
        echo "    # Or download from https://www.docker.com/products/docker-desktop"
        echo "    # Start Docker Desktop, then re-run this script"
        ;;
    esac
    echo ""
    fail "Please install Docker first, then re-run this script."
  fi

  # Verify Docker daemon is running
  if ! docker info &>/dev/null; then
    fail "Docker is installed but the daemon is not running. Start Docker and try again."
  fi

  ok "Docker is installed and running ($(docker --version | head -1))"
}

# ── Check Docker Compose ────────────────────────────────────
check_compose() {
  if docker compose version &>/dev/null; then
    ok "Docker Compose v2 is available ($(docker compose version --short 2>/dev/null || echo 'v2'))"
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    ok "Docker Compose v1 detected ($(docker-compose --version | head -1))"
    COMPOSE_CMD="docker-compose"
    warn "Consider upgrading to Docker Compose v2 for best compatibility."
  else
    fail "Docker Compose is not available. Install it: https://docs.docker.com/compose/install/"
  fi
}

# ── Setup Directory ─────────────────────────────────────────
INSTALL_DIR="${DOCKER_DASH_DIR:-$HOME/docker-dash}"

setup_directory() {
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    info "Existing installation found at $INSTALL_DIR"
    info "Upgrading in place (your .env will be preserved)..."
  else
    mkdir -p "$INSTALL_DIR"
    ok "Created directory: $INSTALL_DIR"
  fi
}

# ── Download Files ──────────────────────────────────────────
REPO_BASE="https://raw.githubusercontent.com/bogdanpricop/docker-dash/main"

download_files() {
  info "Downloading Docker Dash files..."

  # Always download latest docker-compose.yml
  if command -v curl &>/dev/null; then
    curl -fsSL "$REPO_BASE/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"
    curl -fsSL "$REPO_BASE/.env.example" -o "$INSTALL_DIR/.env.example"
  elif command -v wget &>/dev/null; then
    wget -qO "$INSTALL_DIR/docker-compose.yml" "$REPO_BASE/docker-compose.yml"
    wget -qO "$INSTALL_DIR/.env.example" "$REPO_BASE/.env.example"
  else
    fail "Neither curl nor wget found. Install one and try again."
  fi

  ok "Downloaded docker-compose.yml and .env.example"
}

# ── Generate Secrets ────────────────────────────────────────
generate_secrets() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    info ".env already exists — preserving your configuration"
    return
  fi

  info "Generating secure secrets..."

  # Generate random secrets using openssl
  if command -v openssl &>/dev/null; then
    APP_SECRET=$(openssl rand -hex 48)
    ENCRYPTION_KEY=$(openssl rand -hex 32)
  else
    # Fallback to /dev/urandom
    APP_SECRET=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 96)
    ENCRYPTION_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64)
  fi

  # Copy .env.example and replace placeholder secrets
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

  # Replace placeholder values with generated secrets
  if [[ "$OS_NAME" == "macOS" ]]; then
    sed -i '' "s|APP_SECRET=generate-a-random-string-here|APP_SECRET=$APP_SECRET|" "$INSTALL_DIR/.env"
    sed -i '' "s|ENCRYPTION_KEY=change-me-to-a-random-32-char-hex|ENCRYPTION_KEY=$ENCRYPTION_KEY|" "$INSTALL_DIR/.env"
  else
    sed -i "s|APP_SECRET=generate-a-random-string-here|APP_SECRET=$APP_SECRET|" "$INSTALL_DIR/.env"
    sed -i "s|ENCRYPTION_KEY=change-me-to-a-random-32-char-hex|ENCRYPTION_KEY=$ENCRYPTION_KEY|" "$INSTALL_DIR/.env"
  fi

  ok "Generated APP_SECRET and ENCRYPTION_KEY"
  ok "Created .env from template"
}

# ── Update docker-compose.yml for remote install ────────────
patch_compose_for_remote() {
  # If installing remotely (not from git clone), replace build with image
  if [ ! -f "$INSTALL_DIR/Dockerfile" ]; then
    # Replace build section with image reference
    local VERSION
    VERSION=$(grep 'APP_VERSION' "$INSTALL_DIR/docker-compose.yml" | head -1 | grep -oP '\d+\.\d+\.\d+' || echo "latest")

    cat > "$INSTALL_DIR/docker-compose.yml" << 'COMPOSE_EOF'
services:
  app:
    image: ghcr.io/bogdanpricop/docker-dash:latest
    container_name: docker-dash
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "${APP_PORT:-8101}:${APP_PORT:-8101}"
    volumes:
      - ${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock:ro
      - docker-dash-data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT:-8101}/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    security_opt:
      - no-new-privileges:true

volumes:
  docker-dash-data:
    name: docker-dash-data
COMPOSE_EOF
    ok "Configured docker-compose.yml for remote deployment"
  fi
}

# ── Start Services ──────────────────────────────────────────
start_services() {
  info "Starting Docker Dash..."
  cd "$INSTALL_DIR"
  $COMPOSE_CMD up -d

  ok "Docker Dash is starting up..."
}

# ── Success Message ─────────────────────────────────────────
show_success() {
  local PORT
  PORT=$(grep -E '^APP_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8101")
  PORT="${PORT:-8101}"

  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Docker Dash installed successfully!${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  URL:          ${BLUE}http://localhost:${PORT}${NC}"
  echo -e "  Credentials:  ${YELLOW}admin${NC} / ${YELLOW}admin${NC} (change on first login)"
  echo -e "  Install dir:  ${BLUE}${INSTALL_DIR}${NC}"
  echo ""
  echo -e "  Manage:"
  echo -e "    cd $INSTALL_DIR"
  echo -e "    $COMPOSE_CMD logs -f      # View logs"
  echo -e "    $COMPOSE_CMD down         # Stop"
  echo -e "    $COMPOSE_CMD pull && $COMPOSE_CMD up -d  # Update"
  echo ""
  echo -e "  ${YELLOW}Security:${NC} Change the default password on first login!"
  echo ""
}

# ── Main ────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BLUE}  Docker Dash — One-Command Installer${NC}"
  echo -e "${BLUE}  ────────────────────────────────────${NC}"
  echo ""

  detect_platform
  check_docker
  check_compose
  setup_directory
  download_files
  generate_secrets
  patch_compose_for_remote
  start_services
  show_success
}

main "$@"
