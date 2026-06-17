#!/bin/bash
# ============================================================
# Shenmay AI — Self-Hosted Installer
#
# Run this on a fresh Linux server:
#   curl -sSL https://raw.githubusercontent.com/jafools/shenmay-ai/main/scripts/install.sh | bash
#
# Or if you've cloned the repo:
#   bash scripts/install.sh
# ============================================================

set -e

# ── Headless mode (CI/Ansible/Terraform/automated tests) ─────────────────────
# Set SHENMAY_NONINTERACTIVE=1 to skip all prompts and use defaults / env vars:
#   SHENMAY_DIR             — install directory (default: ~/shenmay)
#   SHENMAY_PUBLIC_URL      — public URL (default: http://localhost)
#   SHENMAY_SMTP_HOST       — SMTP host (default: empty / skip)
#   SHENMAY_SMTP_PORT       — SMTP port (default: 465)
#   SHENMAY_SMTP_USER       — SMTP username
#   SHENMAY_SMTP_PASS       — SMTP password
#   SHENMAY_SMTP_FROM       — SMTP from address
#   SHENMAY_CF_TOKEN        — Cloudflare Tunnel token (default: empty / skip)
#   SHENMAY_LICENSE_KEY     — Shenmay license key (default: empty / trial)
#   SHENMAY_AUTO_INSTALL_DOCKER=1 — also auto-install Docker if missing
NONINT="${SHENMAY_NONINTERACTIVE:-0}"

# ── Ensure interactive input works even when piped (curl | bash) ─────────────
# Skip the tty redirect in headless mode — there's nothing to redirect to.
if [ "$NONINT" != "1" ] && [ ! -t 0 ]; then
  exec < /dev/tty
fi

# ── Colours ─────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m'
B='\033[0;34m' W='\033[1;37m' D='\033[2m' NC='\033[0m'

GITHUB_REPO="jafools/shenmay-ai"
# By default, pull from the latest tagged release (reproducible, known-good).
# Override with:
#   SHENMAY_GITHUB_REF=v1.2.0  — pin to a specific release
#   SHENMAY_GITHUB_REF=main    — track latest main (edge / not recommended for prod)
#   SHENMAY_GITHUB_REF=<sha>   — pin to an exact commit
if [ -n "${SHENMAY_GITHUB_REF:-}" ]; then
  GITHUB_REF="$SHENMAY_GITHUB_REF"
else
  # Resolve the latest release tag via the GitHub API.
  # Fall back to "main" if there are no releases yet or the call fails.
  LATEST_TAG=$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | head -1 \
    | sed -E 's/.*"([^"]+)"$/\1/')
  GITHUB_REF="${LATEST_TAG:-main}"
fi
COMPOSE_FILE="docker-compose.selfhosted.yml"
COMPOSE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_REF}/${COMPOSE_FILE}"
INSTALL_DIR="${SHENMAY_DIR:-$HOME/shenmay}"
TOTAL_STEPS=5

# ── Wrap docker calls so they work right after a fresh install ───────────────
# When install.sh installs Docker itself, the new "docker" group membership
# isn't active in the current shell — `docker compose pull` would fail with
# permission denied. We detect that case in step 1 and force `sudo` for the
# rest of the run.
DOCKER_CMD="docker"

step() { echo -e "\n${W}── Step $1 of $TOTAL_STEPS  $2${NC}"; }
ok()   { echo -e "   ${G}✓${NC} $1"; }
warn() { echo -e "   ${Y}⚠${NC}  $1"; }
fail() { echo -e "\n${R}Error:${NC} $1\n"; exit 1; }
ask()  { echo -e "   ${B}?${NC}  $1"; }

# ── Header ───────────────────────────────────────────────────
# Skip `clear` if TERM isn't set (CI/non-tty environments — would error
# under `set -e`) or in headless mode (script output should be linear).
if [ -n "$TERM" ] && [ "$NONINT" != "1" ]; then
  clear
fi
echo ""
echo -e "${W}╔═══════════════════════════════════════════╗${NC}"
echo -e "${W}║          Shenmay AI — Self-Hosted           ║${NC}"
echo -e "${W}║             Setup Wizard v2.0             ║${NC}"
echo -e "${W}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${D}This script installs Shenmay AI on your server."
echo -e "Once it finishes, open your browser to complete the setup.${NC}"
echo ""

# ════════════════════════════════════════════════
step 1 "Check requirements"
# ════════════════════════════════════════════════

if [[ "$OSTYPE" != "linux-gnu"* ]]; then
  warn "This script is designed for Linux. You're running: $OSTYPE"
  warn "Continuing anyway — some steps may need manual adjustment."
fi

if ! command -v docker &>/dev/null; then
  echo ""
  warn "Docker is not installed."
  echo ""

  if [ "$NONINT" = "1" ]; then
    if [ "${SHENMAY_AUTO_INSTALL_DOCKER:-0}" = "1" ]; then
      INSTALL_DOCKER="y"
    else
      fail "Docker is required. Set SHENMAY_AUTO_INSTALL_DOCKER=1 to auto-install, or install it from https://docs.docker.com/get-docker/ and re-run."
    fi
  else
    ask "Install Docker automatically? This requires sudo. [Y/n]"
    read -r INSTALL_DOCKER
    if [[ "$INSTALL_DOCKER" =~ ^[Nn]$ ]]; then
      fail "Docker is required. Install it from https://docs.docker.com/get-docker/ and re-run this script."
    fi
  fi

  echo ""
  echo -e "   ${D}Installing Docker...${NC}"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo ""
  ok "Docker installed."
  # The new docker group isn't active in the current shell — run subsequent
  # docker commands via sudo so the install completes in a single script run.
  # The user can drop the sudo on subsequent runs (after they re-login).
  DOCKER_CMD="sudo docker"
  warn "Using sudo for docker for the rest of this run."
  warn "Log out and back in (or run 'newgrp docker') so future commands work without sudo."
else
  ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"
fi

if ! $DOCKER_CMD compose version &>/dev/null; then
  fail "Docker Compose v2 not found. Update Docker Desktop or install the plugin:\n   https://docs.docker.com/compose/install/"
fi
ok "Docker Compose $($DOCKER_CMD compose version --short)"

if ! sudo docker info &>/dev/null 2>&1; then
  echo ""
  echo -e "   ${D}Starting Docker daemon...${NC}"
  sudo systemctl start docker 2>/dev/null || true
  sleep 3
  if ! sudo docker info &>/dev/null 2>&1; then
    fail "Docker is installed but not running. Try: sudo systemctl start docker"
  fi
fi
ok "Docker daemon is running"

# ════════════════════════════════════════════════
step 2 "Choose installation directory"
# ════════════════════════════════════════════════

echo ""
echo -e "   ${D}Shenmay AI will be installed to a folder on your server."
echo -e "   This folder stores your configuration and database.${NC}"
echo ""

if [ "$NONINT" = "1" ]; then
  ok "Headless: using $INSTALL_DIR (set SHENMAY_DIR to override)"
else
  ask "Installation directory [${INSTALL_DIR}]:"
  read -r USER_DIR
  INSTALL_DIR="${USER_DIR:-$INSTALL_DIR}"
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
ok "Using: $INSTALL_DIR"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo ""
  echo -e "   ${D}Downloading Shenmay AI configuration...${NC}"
  if command -v curl &>/dev/null; then
    curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"
  elif command -v wget &>/dev/null; then
    wget -q "$COMPOSE_URL" -O "$COMPOSE_FILE"
  else
    fail "Neither curl nor wget found. Please install curl and re-run."
  fi
  ok "Configuration downloaded"
else
  ok "Configuration file already present"
fi

# ════════════════════════════════════════════════
step 3 "Configure Shenmay AI"
# ════════════════════════════════════════════════

if [ -f ".env" ]; then
  echo ""
  warn "An existing .env configuration was found."
  if [ "$NONINT" = "1" ]; then
    ok "Headless: keeping existing .env (set SHENMAY_FORCE_RECONFIGURE=1 to overwrite)"
    if [ "${SHENMAY_FORCE_RECONFIGURE:-0}" != "1" ]; then
      SKIP_CONFIG=1
    fi
  else
    ask "Reconfigure from scratch? Existing settings will be overwritten. [y/N]"
    read -r REDO
    if [[ ! "$REDO" =~ ^[Yy]$ ]]; then
      ok "Keeping existing configuration — skipping setup."
      SKIP_CONFIG=1
    fi
  fi
fi

if [ "${SKIP_CONFIG}" != "1" ]; then

  echo ""
  echo -e "   ${D}Answer the questions below. Press Enter to accept the default shown in [brackets].${NC}"
  echo ""

  # ── Public URL ────────────────────────────────
  echo -e "   ${W}Your public URL${NC}"
  echo -e "   ${D}The web address where Shenmay will be accessible."
  echo -e "   Examples: https://shenmay.yourfirm.com  or  http://192.168.1.100${NC}"
  if [ "$NONINT" = "1" ]; then
    PUBLIC_URL="${SHENMAY_PUBLIC_URL:-http://localhost}"
    ok "Headless: using $PUBLIC_URL"
  else
    ask "Public URL [http://localhost]:"
    read -r PUBLIC_URL
    PUBLIC_URL="${PUBLIC_URL:-http://localhost}"
  fi

  # ── SMTP ──────────────────────────────────────
  echo ""
  echo -e "   ${W}Email (SMTP) — optional but recommended${NC}"
  echo -e "   ${D}Used for advisor notifications and invite emails."
  echo -e "   Skip for now by pressing Enter — you can add it later in .env${NC}"
  if [ "$NONINT" = "1" ]; then
    SMTP_HOST="${SHENMAY_SMTP_HOST:-}"
    SMTP_PORT="${SHENMAY_SMTP_PORT:-465}"
    SMTP_USER="${SHENMAY_SMTP_USER:-}"
    SMTP_PASS="${SHENMAY_SMTP_PASS:-}"
    SMTP_FROM="${SHENMAY_SMTP_FROM:-}"
    if [ -n "$SMTP_HOST" ]; then
      ok "Headless: SMTP $SMTP_HOST:$SMTP_PORT (user $SMTP_USER)"
    else
      ok "Headless: no SMTP configured"
    fi
  else
    ask "SMTP host [skip]:"
    read -r SMTP_HOST

    if [ -n "$SMTP_HOST" ]; then
      ask "SMTP port [465]:"
      read -r SMTP_PORT
      SMTP_PORT="${SMTP_PORT:-465}"
      ask "SMTP username:"
      read -r SMTP_USER
      ask "SMTP password:"
      read -rs SMTP_PASS
      echo ""
      ask "From address [noreply@$(echo "$PUBLIC_URL" | sed 's|https\?://||' | cut -d'/' -f1)]:"
      read -r SMTP_FROM
      SMTP_FROM="${SMTP_FROM:-noreply@$(echo "$PUBLIC_URL" | sed 's|https\?://||' | cut -d'/' -f1)}"
    fi
  fi

  # ── Cloudflare Tunnel ─────────────────────────
  echo ""
  echo -e "   ${W}Cloudflare Tunnel — optional${NC}"
  echo -e "   ${D}Gives your Shenmay installation a public HTTPS address without"
  echo -e "   opening firewall ports or managing SSL certificates."
  echo -e "   Create a free tunnel at: dash.cloudflare.com > Zero Trust > Networks > Tunnels"
  echo -e "   Leave blank to skip — you can add it later in .env${NC}"
  if [ "$NONINT" = "1" ]; then
    CF_TOKEN="${SHENMAY_CF_TOKEN:-}"
    if [ -n "$CF_TOKEN" ]; then
      ok "Headless: Cloudflare Tunnel token set"
    else
      ok "Headless: no Cloudflare Tunnel"
    fi
  else
    ask "Cloudflare Tunnel token [skip]:"
    read -r CF_TOKEN
  fi

  # ── License key ──────────────────────────────
  echo ""
  echo -e "   ${W}Shenmay AI license key — optional${NC}"
  echo -e "   ${D}Leave blank to start with the free trial (20 messages/mo, 1 customer)."
  echo -e "   If you already have a paid license key, enter it here."
  echo -e "   You can add or upgrade a key at any time by editing .env and restarting.${NC}"
  if [ "$NONINT" = "1" ]; then
    SHENMAY_LICENSE_KEY="${SHENMAY_LICENSE_KEY:-}"
    if [ -z "$SHENMAY_LICENSE_KEY" ]; then
      ok "Headless: starting on free trial"
    else
      ok "Headless: license key set"
    fi
  else
    ask "License key (SHENMAY-XXXX-XXXX-XXXX-XXXX) [Enter for free trial]:"
    read -r SHENMAY_LICENSE_KEY
    if [ -z "$SHENMAY_LICENSE_KEY" ]; then
      ok "Starting with free trial — 20 messages/mo, 1 customer"
    else
      ok "License key noted — will be validated on first start"
    fi
  fi

  # ── Generate secrets ──────────────────────────
  echo ""
  echo -e "   ${D}Generating secure secrets...${NC}"
  gen_secret() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 64; }
  JWT_SECRET=$(gen_secret)
  WIDGET_JWT_SECRET=$(gen_secret)
  API_KEY_ENCRYPTION_SECRET=$(gen_secret)
  DB_PASSWORD=$(gen_secret | head -c 32)
  ok "Secrets generated"

  # ── Write .env ────────────────────────────────
  cat > .env << ENV
# Shenmay AI — Configuration
# Generated by install.sh on $(date)
# Edit this file to change settings, then run:
#   docker compose -f docker-compose.selfhosted.yml up -d

# ── Database ─────────────────────────────────
DB_PASSWORD=${DB_PASSWORD}

# ── Security (do not share these) ────────────
JWT_SECRET=${JWT_SECRET}
WIDGET_JWT_SECRET=${WIDGET_JWT_SECRET}
API_KEY_ENCRYPTION_SECRET=${API_KEY_ENCRYPTION_SECRET}

# ── App URL ───────────────────────────────────
APP_URL=${PUBLIC_URL}
FRONTEND_URL=${PUBLIC_URL}

# ── Email / SMTP ──────────────────────────────
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT:-465}
SMTP_SECURE=true
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM=${SMTP_FROM}

# ── Cloudflare Tunnel (optional) ──────────────
CLOUDFLARE_TUNNEL_TOKEN=${CF_TOKEN}

# ── Shenmay License ─────────────────────────────
# Leave blank for free trial (20 messages/mo, 1 customer).
# Upgrade at: https://pontensolutions.com/shenmay/license
SHENMAY_LICENSE_KEY=${SHENMAY_LICENSE_KEY}
# Optional: pin a stable license-binding id. Leave blank — one is generated and
# persisted on first boot, so restarts and domain changes don't rebind. Set it
# only to carry one id across server moves (docs/RUNBOOK-LICENSE-REBIND.md).
#SHENMAY_INSTANCE_ID=
ENV

  ok "Configuration saved to .env"
fi

# ════════════════════════════════════════════════
step 4 "Download and start services"
# ════════════════════════════════════════════════

echo ""
echo -e "   ${D}Pulling Docker images (this may take a few minutes)...${NC}"
echo ""

# Auto-enable the cloudflared profile when a tunnel token is configured.
# We re-read .env in case this is a "keep existing config" run.
if [ -f .env ]; then
  CFT=$(grep -E '^CLOUDFLARE_TUNNEL_TOKEN=' .env | cut -d= -f2-)
else
  CFT=""
fi
if [ -n "$CFT" ]; then
  COMPOSE_PROFILE_FLAG=(--profile tunnel)
  ok "Cloudflare Tunnel enabled (--profile tunnel)"
else
  COMPOSE_PROFILE_FLAG=()
fi

$DOCKER_CMD compose "${COMPOSE_PROFILE_FLAG[@]}" -f "$COMPOSE_FILE" pull

echo ""
echo -e "   ${D}Starting services...${NC}"
echo ""

$DOCKER_CMD compose "${COMPOSE_PROFILE_FLAG[@]}" -f "$COMPOSE_FILE" up -d

ok "Services started"

# ════════════════════════════════════════════════
step 5 "Wait for Shenmay AI to be ready"
# ════════════════════════════════════════════════

echo ""
echo -e "   ${D}Waiting for the API to come online (up to 60 seconds)...${NC}"

READY=0
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    READY=1
    break
  fi
  printf "."
  sleep 2
done
echo ""

if [ "$READY" -eq 1 ]; then
  ok "API is healthy"
else
  warn "API health check timed out — services may still be starting."
  warn "Check logs with: docker compose -f $INSTALL_DIR/$COMPOSE_FILE logs -f backend"
fi

# ════════════════════════════════════════════════
echo ""
echo -e "${W}╔═══════════════════════════════════════════╗${NC}"
echo -e "${W}║       Shenmay AI is almost ready!           ║${NC}"
echo -e "${W}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo -e "   ${W}One last step — open your browser and go to:${NC}"

source .env 2>/dev/null || true
echo -e "   ${B}${APP_URL:-http://localhost}${NC}"
echo ""
echo -e "   ${D}A setup wizard will guide you through creating your"
echo -e "   admin account and connecting your Anthropic API key."
echo -e "   It takes about 60 seconds.${NC}"
echo ""
echo -e "   ${D}────────────────────────────────────────${NC}"
echo -e "   ${W}Useful commands:${NC}"
echo -e "   ${D}View logs:   ${NC}docker compose -f ${COMPOSE_FILE} logs -f backend"
echo -e "   ${D}Stop:        ${NC}docker compose -f ${COMPOSE_FILE} down"
echo -e "   ${D}Update:      ${NC}docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d"
echo -e "   ${D}Edit config: ${NC}nano ${INSTALL_DIR}/.env"
echo ""
echo -e "   ${D}All files are in: ${INSTALL_DIR}${NC}"
echo -e "   ${D}Your database is persisted in a Docker volume and survives restarts.${NC}"
echo ""
