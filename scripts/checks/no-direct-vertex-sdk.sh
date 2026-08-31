#!/usr/bin/env bash
# T-APP-02 / DEC-APP-10. Four applications call an LLM. They share one client so the
# model name comes from the deployment rather than from four separate literals.
set -euo pipefail
cd "$(dirname "$0")/../.."

hits=$(grep -rln "@google-cloud/vertexai" --include='*.ts' --include='package.json' apps packages 2>/dev/null \
  | grep -v node_modules | grep -v '^packages/xaa-vertex/' || true)
if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "the Vertex SDK is used only from packages/xaa-vertex" >&2
  exit 1
fi
echo "ok: the Vertex SDK has one caller"
