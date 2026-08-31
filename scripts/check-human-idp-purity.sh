#!/usr/bin/env bash
# RULE-47 / RULE-50: Human IdP must not know about agents. It has no Agent Registry,
# no per-agent client registration and no agent policy, and it never redeems or
# issues an ID-JAG. The two allowed occurrences are the fixed client id
# `agent-platform` and the env var `AGENT_OP_CALLBACK_URI`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/apps/human-idp/src"
status=0

if [ ! -d "$src" ]; then
  echo "check-human-idp-purity: $src does not exist" >&2
  exit 1
fi

# src/oidc is the committed generator output; check-oidc-patches.mjs pins it to the
# baseline, so it is inspected there rather than here.
files=$(find "$src" -name '*.ts' -not -path '*/oidc/*')
if [ -z "$files" ]; then
  echo "check-human-idp-purity: no sources to inspect" >&2
  exit 1
fi

# shellcheck disable=SC2086
# `agent_id` survives only as the always-null column REQ-09-004 requires in every
# log line, and in the comment that explains why it is always null.
hits=$(grep -nE 'agent_id|agents/|isolation|capability|dedicated_op' $files \
  | grep -v 'agent-platform' \
  | grep -v 'AGENT_OP_CALLBACK_URI' \
  | grep -vE 'agent_id: null' \
  | grep -vE ':[[:space:]]*(//|\*)' \
  || true)
if [ -n "$hits" ]; then
  echo "check-human-idp-purity: agent context found in Human IdP" >&2
  echo "$hits" >&2
  status=1
fi

# T-IDP-17: ID-JAG lives in the experimental package. Human IdP must not import it.
# shellcheck disable=SC2086
experimental=$(grep -n '@maronn-openid-connect/experimental' $files || true)
if [ -n "$experimental" ]; then
  echo "check-human-idp-purity: Human IdP must not import the experimental package" >&2
  echo "$experimental" >&2
  status=1
fi

# T-IDP-08: the four collections Human IdP may reach, and no others.
matrix="$root/packages/gcp/src/access-matrix.json"
allowed=$(node -e '
  const matrix = require(process.argv[1])["human-idp"];
  const paths = [...new Set([...matrix.read, ...matrix.write])].map((p) => p.split("/")[0]).sort();
  const expected = ["consents", "dpop_jti", "idp_sessions", "idp_tokens", "idp_transactions", "idp_users"];
  process.stdout.write(JSON.stringify(paths) === JSON.stringify(expected) ? "ok" : JSON.stringify(paths));
' "$matrix")
if [ "$allowed" != "ok" ]; then
  echo "check-human-idp-purity: unexpected collection set for human-idp: $allowed" >&2
  status=1
fi

exit $status
