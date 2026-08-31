#!/usr/bin/env bash
# DEC-IAC-08: Provisioner and Lifecycle Manager are the only apps allowed to create
# and delete GCP resources at run time, and only inside the `dedicated-op-` /
# `sa-op-` / `sa-agent-` / `idjag-` / `idpconn-` / `agent-runtime-` name space.
# The boundary is enforced by name, so every mutating call must sit in a function
# that also calls assertRuntimeName, and no Terraform-managed name may appear as an
# argument. grep is used rather than ripgrep so the check runs anywhere.
set -euo pipefail

roots=(apps/provisioner/src apps/lifecycle-manager/src)
for root in "${roots[@]}"; do
  [[ -d "$root" ]] || { echo "missing scan root: $root" >&2; exit 1; }
done

sources=()
while IFS= read -r file; do sources+=("$file"); done < <(find "${roots[@]}" -type f -name '*.ts' | sort)
if ((${#sources[@]} == 0)); then
  echo 'no sources found under the runtime mutation scope' >&2
  exit 1
fi

status=0

if grep -n 'createKeyRing' "${sources[@]}"; then
  echo 'runtime code must never create a KMS key ring' >&2
  status=1
fi

mutations='createService|deleteService|updateService|createJob|deleteJob|createCryptoKey|destroyCryptoKeyVersion|createServiceAccount|deleteServiceAccount'
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  if ! grep -q 'assertRuntimeName' "$file"; then
    echo "runtime mutation without assertRuntimeName: $file" >&2
    status=1
  fi
done < <(grep -lE "\.($mutations)\(" "${sources[@]}" || true)

managed='human-idp|shared-agent-op|automation-app|authorization|security-detection|resource-(docs|finance)-(as|api)|agent-op-callback|lifecycle'
if grep -nE "\.($mutations)\([^)]*['\"]($managed)['\"]" "${sources[@]}"; then
  echo 'Terraform-managed resource name passed to a runtime mutation' >&2
  status=1
fi

exit "$status"
