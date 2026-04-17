#!/usr/bin/env bash
# Vigil Hub external watchdog.
#
# Polls http://localhost:3000/api/health. Tracks last-known state in
# /tmp/vigil-hub-watchdog.state. On up->down and down->up transitions,
# posts to Slack / Teams / Discord webhooks read from ~/.config/vigil/.
#
# Self-contained: only bash + curl. Does not depend on the Hub's own
# alert dispatcher (the whole point — Hub might be the thing that is down).
#
# Debounce: requires 2 consecutive failures (~120s) before declaring DOWN.
# Always exits 0 so a cron/systemd timer never backs off.

set -u

readonly HEALTH_URL="${VIGIL_WATCHDOG_URL:-http://localhost:3000/api/health}"
readonly STATE_FILE="${VIGIL_WATCHDOG_STATE:-/tmp/vigil-hub-watchdog.state}"
readonly LOG_FILE="${VIGIL_WATCHDOG_LOG:-/tmp/vigil-hub-watchdog.log}"
readonly CONFIG_DIR="${VIGIL_WATCHDOG_CONFIG_DIR:-$HOME/.config/vigil}"
readonly SLACK_URL_FILE="$CONFIG_DIR/watchdog-slack-url"
readonly TEAMS_URL_FILE="$CONFIG_DIR/watchdog-teams-url"
readonly DISCORD_URL_FILE="$CONFIG_DIR/watchdog-discord-url"
readonly CURL_TIMEOUT="${VIGIL_WATCHDOG_CURL_TIMEOUT:-8}"
readonly HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"

log() {
  # log <level> <message...>
  local level="$1"; shift
  local msg="$*"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '%s %s %s\n' "$ts" "$level" "$msg" >> "$LOG_FILE"
}

# Probe the Hub.
# Returns 0 if Hub responded with an HTTP status < 500 (server is alive —
# any 1xx/2xx/3xx/4xx proves Next.js is serving requests).
# Returns 1 on timeout, connection refused, DNS failure, or 5xx.
# Prints the numeric code (or "000" on curl error) on stdout in both cases.
probe_hub() {
  # curl always writes %{http_code} to stdout — even on error (000). The
  # `|| true` prevents `set -e` from killing us (we're set -u only, but keep
  # it safe). We do NOT append a fallback echo — that would double-print on
  # failure (e.g. "000" from curl + "000" from fallback = "000000").
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$HEALTH_URL" 2>/dev/null)" || true
  [[ -n "$code" ]] || code="000"
  if [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]; then
    printf '%s' "$code"
    return 0
  fi
  printf '%s' "$code"
  return 1
}

# Read a webhook URL from a file, stripping whitespace and ignoring blank /
# comment lines. Prints the URL if present, exits 1 if absent/empty/invalid.
read_webhook() {
  local file="$1"
  [[ -r "$file" ]] || return 1
  local url
  url="$(grep -v -E '^[[:space:]]*(#|$)' "$file" 2>/dev/null | head -n1 | tr -d '[:space:]')"
  [[ -n "$url" ]] || return 1
  [[ "$url" =~ ^https?:// ]] || return 1
  printf '%s' "$url"
}

# JSON string escaper — handles backslash, double-quote, newline, CR, tab.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

curl_http_code() {
  # Helper: returns the HTTP status code on stdout; "000" on connection error.
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$@" 2>/dev/null)" || true
  [[ -n "$code" ]] || code="000"
  printf '%s' "$code"
}

post_slack() {
  local url="$1" text="$2"
  local payload
  payload="{\"text\":\"$(json_escape "$text")\"}"
  local http
  http="$(curl_http_code -H 'Content-Type: application/json' -X POST --data "$payload" "$url")"
  if [[ "$http" =~ ^2[0-9][0-9]$ ]]; then
    log INFO "slack webhook delivered (http=$http)"
  else
    log WARN "slack webhook failed (http=$http)"
  fi
}

post_teams() {
  local url="$1" title="$2" text="$3" color="$4"
  local payload
  payload="{\"@type\":\"MessageCard\",\"@context\":\"https://schema.org/extensions\",\"summary\":\"$(json_escape "$title")\",\"themeColor\":\"$color\",\"title\":\"$(json_escape "$title")\",\"text\":\"$(json_escape "$text")\"}"
  local http
  http="$(curl_http_code -H 'Content-Type: application/json' -X POST --data "$payload" "$url")"
  if [[ "$http" =~ ^2[0-9][0-9]$ ]]; then
    log INFO "teams webhook delivered (http=$http)"
  else
    log WARN "teams webhook failed (http=$http)"
  fi
}

post_discord() {
  local url="$1" text="$2"
  local payload
  payload="{\"content\":\"$(json_escape "$text")\"}"
  local http
  http="$(curl_http_code -H 'Content-Type: application/json' -X POST --data "$payload" "$url")"
  # Discord webhooks respond 204 No Content on success.
  if [[ "$http" =~ ^2[0-9][0-9]$ ]]; then
    log INFO "discord webhook delivered (http=$http)"
  else
    log WARN "discord webhook failed (http=$http)"
  fi
}

notify_all() {
  local title="$1" text="$2" color="$3"
  local any=0

  local slack_url teams_url discord_url
  if slack_url="$(read_webhook "$SLACK_URL_FILE")"; then
    post_slack "$slack_url" "$text"
    any=1
  fi
  if teams_url="$(read_webhook "$TEAMS_URL_FILE")"; then
    post_teams "$teams_url" "$title" "$text" "$color"
    any=1
  fi
  if discord_url="$(read_webhook "$DISCORD_URL_FILE")"; then
    post_discord "$discord_url" "$text"
    any=1
  fi

  if [[ "$any" -eq 0 ]]; then
    log WARN "no webhook files configured — transition recorded, no alert sent"
  fi
}

main() {
  # Ensure sensible perms on log (may be created by us here).
  umask 077
  : >> "$LOG_FILE"

  local now; now="$(date +%s)"

  # Load previous state.
  local prev_state="up"
  local prev_fail_count=0
  local down_since=0
  if [[ -r "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE" 2>/dev/null || true
  fi

  # Probe.
  local code rc
  code="$(probe_hub)"; rc=$?

  if [[ $rc -eq 0 ]]; then
    # Hub responded.
    if [[ "$prev_state" == "down" ]]; then
      local downtime=$(( now - down_since ))
      local msg="Vigil Hub RECOVERED on ${HOSTNAME_SHORT} — back up after ${downtime}s. (${HEALTH_URL} -> HTTP ${code})"
      log INFO "state transition: down -> up (downtime=${downtime}s, http=${code})"
      notify_all "Vigil Hub recovered" "$msg" "00c853"
    elif [[ "$prev_fail_count" -gt 0 ]]; then
      log INFO "hub recovered before debounce threshold (prev_fail_count=${prev_fail_count}, http=${code})"
    else
      log DEBUG "hub up (http=${code})"
    fi
    cat >"$STATE_FILE" <<EOF
prev_state="up"
prev_fail_count=0
down_since=0
last_check=${now}
last_http=${code}
EOF
  else
    # Hub did not respond properly.
    local new_fail_count=$(( prev_fail_count + 1 ))
    if [[ "$prev_state" == "up" ]]; then
      if [[ "$new_fail_count" -ge 2 ]]; then
        # Transition up -> down.
        local msg="Vigil Hub is DOWN on ${HOSTNAME_SHORT} — no response from ${HEALTH_URL} (curl_code=${code}) after ${new_fail_count} consecutive failures."
        log ERROR "state transition: up -> down (fail_count=${new_fail_count}, probe=${code})"
        notify_all "Vigil Hub is DOWN" "$msg" "d50000"
        cat >"$STATE_FILE" <<EOF
prev_state="down"
prev_fail_count=${new_fail_count}
down_since=${now}
last_check=${now}
last_http=${code}
EOF
      else
        log WARN "hub probe failed (fail_count=${new_fail_count}, probe=${code}) — waiting for debounce"
        cat >"$STATE_FILE" <<EOF
prev_state="up"
prev_fail_count=${new_fail_count}
down_since=0
last_check=${now}
last_http=${code}
EOF
      fi
    else
      # Already down — still down, bump fail count, keep down_since.
      log WARN "hub still down (fail_count=${new_fail_count}, probe=${code})"
      cat >"$STATE_FILE" <<EOF
prev_state="down"
prev_fail_count=${new_fail_count}
down_since=${down_since}
last_check=${now}
last_http=${code}
EOF
    fi
  fi

  exit 0
}

main "$@"
