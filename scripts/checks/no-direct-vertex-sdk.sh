#!/usr/bin/env bash
set -euo pipefail

if rg -n '@google-cloud/vertexai' apps packages --glob '*.ts' --glob '!packages/xaa-vertex/**' --glob '!**/dist/**'; then
  echo 'Vertex SDK imports are restricted to @xaa/vertex' >&2
  exit 1
fi
