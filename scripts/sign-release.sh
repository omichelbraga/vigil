#!/usr/bin/env bash
# sign-release.sh — produce an ed25519 signature over the sha256-hex of an
# agent binary. The Hub publishes this signature alongside the release; every
# agent with the matching pubkey baked in verifies it before applying the
# update.
#
# Usage:  scripts/sign-release.sh <binary-path>
# Env:    VIGIL_UPDATE_SIGNING_KEY  path to the PKCS8 PEM private key
#         (default: ~/.config/vigil/update-signing-key.pem)

set -euo pipefail

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "usage: $0 <binary-path>" >&2
  exit 2
fi

KEY="${VIGIL_UPDATE_SIGNING_KEY:-$HOME/.config/vigil/update-signing-key.pem}"
if [[ ! -f "$KEY" ]]; then
  echo "signing key not found: $KEY" >&2
  exit 2
fi

SHA=$(sha256sum "$BIN" | awk '{print $1}')

PUBKEY_HEX="$(cat "${VIGIL_UPDATE_PUBKEY_FILE:-$HOME/.config/vigil/update-pubkey.hex}" | tr -d '[:space:]')"

# CommonJS, not ESM — `node --input-type=module -e` requires Node 12+ and the
# self-hosted runner image (myoung34/github-runner) ships an older node that
# rejects --input-type entirely. `node -e` defaults to CJS, which works
# everywhere.
exec node -e "
const { readFileSync } = require('fs');
const { createPrivateKey, sign, createHash } = require('crypto');
const priv = createPrivateKey({ key: readFileSync('$KEY'), format: 'pem', type: 'pkcs8' });
const sigBuf = sign(null, Buffer.from('$SHA', 'utf8'), priv);
const rawPub = Buffer.from('$PUBKEY_HEX', 'hex');
const fingerprint = createHash('sha256').update(rawPub).digest('hex').slice(0,8);
process.stdout.write(JSON.stringify({
  sha256: '$SHA',
  signature: sigBuf.toString('hex'),
  signedBy: fingerprint
}) + '\n');
"
