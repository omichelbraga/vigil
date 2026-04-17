#!/usr/bin/env bash
# Vigil Hub watchdog bootstrap / installer.
#
# Idempotent: safe to re-run. Does not modify the Hub DB beyond a single
# read-only SELECT of alert_channels to help seed webhook URLs.
#
# Steps:
#   1. Create ~/.config/vigil/ (0700).
#   2. For each channel type (slack, teams, discord): if ~/.config/vigil/
#      watchdog-<type>-url is missing, try to read the config from the
#      Postgres container. If the stored config is PLAINTEXT JSON with a
#      url field, seed it (chmod 0600). Otherwise (encrypted), print
#      manual instructions — the watchdog must remain independent of the
#      Hub, so we never import VIGIL_ENCRYPTION_KEY here.
#   3. Install systemd user units to ~/.config/systemd/user/ and enable
#      the timer.
#   4. Run the watchdog once to verify it works.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

readonly CONFIG_DIR="$HOME/.config/vigil"
readonly SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
readonly WATCHDOG_SCRIPT="$SCRIPT_DIR/hub-watchdog.sh"
readonly UNIT_SERVICE="$SCRIPT_DIR/watchdog.service"
readonly UNIT_TIMER="$SCRIPT_DIR/watchdog.timer"

readonly PG_CONTAINER="${VIGIL_PG_CONTAINER:-vigil-postgres}"
readonly PG_USER="${VIGIL_PG_USER:-vigil}"
readonly PG_DB="${VIGIL_PG_DB:-vigil}"

info()  { printf '[install] %s\n' "$*"; }
warn()  { printf '[install] WARNING: %s\n' "$*" >&2; }
fatal() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || fatal "required command not found: $1"
}

need bash
need curl
need systemctl

[[ -x "$WATCHDOG_SCRIPT" ]] || fatal "watchdog script not found or not executable: $WATCHDOG_SCRIPT"
[[ -f "$UNIT_SERVICE" ]]   || fatal "service unit not found: $UNIT_SERVICE"
[[ -f "$UNIT_TIMER" ]]     || fatal "timer unit not found: $UNIT_TIMER"

# --- 1. Config dir ----------------------------------------------------------
info "Ensuring config directory $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# Single read-only SELECT against the alert_channels table. The real Vigil
# schema (Prisma snake-case) is:
#   CREATE TABLE alert_channels (
#     id, name, type, config jsonb, enabled bool, created_at, updated_at
#   );
# Even though vigil-hub/lib/encryption.ts exists for sensitive values, the
# webhook URL payloads observed in this deployment are stored as PLAINTEXT
# JSON (jsonb) — the encryption module is applied to other secrets. We
# defensively detect ciphertext (three colon-separated base64 chunks) and
# refuse to touch it if ever encountered.
seed_channel() {
  local type="$1"
  local file="$CONFIG_DIR/watchdog-${type}-url"

  if [[ -s "$file" ]]; then
    info "Webhook file for '${type}' already present, leaving untouched: $file"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not available — cannot auto-seed '${type}'. Paste the plaintext webhook URL manually:"
    warn "  echo 'https://hooks.example/...' > $file && chmod 600 $file"
    return 0
  fi
  if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
    warn "Postgres container '${PG_CONTAINER}' not running — cannot auto-seed '${type}'."
    warn "Paste the plaintext webhook URL manually:"
    warn "  echo 'https://hooks.example/...' > $file && chmod 600 $file"
    return 0
  fi

  local url
  url="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAq \
          -c "SELECT config->>'url' FROM alert_channels WHERE type='${type}' AND enabled = true ORDER BY created_at ASC LIMIT 1;" 2>/dev/null \
          | tr -d '[:space:]')"

  if [[ -z "$url" ]]; then
    info "No enabled '${type}' channel with a url field found in DB — skipping auto-seed."
    info "  Paste manually when ready:"
    info "    echo 'https://hooks.example/...' > $file && chmod 600 $file"
    return 0
  fi

  # Ciphertext guard: our encryption format is <ivB64>:<cipherB64>:<tagB64>.
  # Such a string contains no slashes that a URL has; if this ever matches,
  # we refuse and ask the operator for plaintext.
  if [[ ! "$url" =~ ^https?:// ]]; then
    if [[ "$url" =~ ^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]]; then
      warn "The '${type}' channel URL in DB appears to be AES-256-GCM encrypted (vigil-hub/lib/encryption.ts)."
      warn "The watchdog intentionally does NOT import VIGIL_ENCRYPTION_KEY."
      warn "Paste the plaintext webhook URL manually:"
      warn "  echo 'https://hooks.example/...' > $file && chmod 600 $file"
    else
      warn "Unrecognized URL format for '${type}': ${url:0:40}..."
      warn "Paste the plaintext webhook URL manually:"
      warn "  echo 'https://hooks.example/...' > $file && chmod 600 $file"
    fi
    return 0
  fi

  umask 077
  printf '%s\n' "$url" > "$file"
  chmod 600 "$file"
  info "Seeded $file from DB (plaintext channel '${type}')."
}

# --- 2. Seed webhook URL files ---------------------------------------------
seed_channel slack
seed_channel teams
seed_channel discord

# --- 3. Install systemd user units -----------------------------------------
info "Installing systemd user units into $SYSTEMD_USER_DIR"
mkdir -p "$SYSTEMD_USER_DIR"
install -m 0644 "$UNIT_SERVICE" "$SYSTEMD_USER_DIR/watchdog.service"
install -m 0644 "$UNIT_TIMER"   "$SYSTEMD_USER_DIR/watchdog.timer"

systemctl --user daemon-reload
systemctl --user enable --now watchdog.timer

info "Timer status:"
systemctl --user --no-pager status watchdog.timer || true

# --- 4. Self-verify ---------------------------------------------------------
info "Running watchdog once to verify..."
"$WATCHDOG_SCRIPT"
info "Recent log entries:"
tail -n 5 /tmp/vigil-hub-watchdog.log 2>/dev/null || info "  (log file empty)"

info "Install complete."
info ""
info "To test alerting end-to-end:"
info "  systemctl --user stop vigil-hub"
info "  $WATCHDOG_SCRIPT    # 1st failure (below debounce)"
info "  $WATCHDOG_SCRIPT    # 2nd failure — should fire DOWN alert"
info "  systemctl --user start vigil-hub"
info "  sleep 10; $WATCHDOG_SCRIPT    # should fire RECOVERY alert"
