#!/usr/bin/env bash
# T-APP-11 / RULE-07. Deciding what an agent may do belongs to the Authorization
# Platform. The surest way to keep it there is for this app not to know the words: no
# capability id, no resource scope, no isolation level anywhere it could branch on one.
# Values received over HTTP are displayed as opaque strings, which needs no vocabulary.
set -euo pipefail
cd "$(dirname "$0")/../.."

patterns='calendar\.event\.|document\.read|document\.write|mail\.message\.|finance\.payment\.|full_isolation|standard_isolation|docs\.read|docs\.write|finance\.tx\.'

if ! node scripts/checks/code-grep.mjs "$patterns" apps/automation-app/src >&2; then
  echo "automation-app must not carry the authorization vocabulary" >&2
  exit 1
fi
echo "ok: automation-app carries no capability, scope or isolation vocabulary"
