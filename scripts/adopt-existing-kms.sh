#!/usr/bin/env bash
# GCP never deletes a KMS key ring or a crypto key. A project that has been through
# `make destroy-all` therefore still holds the ones an earlier deploy created, while the
# state that described them went with the state bucket, and creating them again answers
# 409. This adopts what the project already has so the shared apply can proceed.
#
# It is a no-op on a project that has its shared state, and on one that has never been
# deployed: only a ring or key that exists in GCP and is missing from state is imported.
#
# DEC-IAC-04 fixes the platform on the version GCP creates with the key, which is always
# version 1, so an adopted key whose version 1 is not enabled is reported rather than
# quietly deployed. A version scheduled for destruction is still restorable, and that is
# the case this can repair.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

project_id=${PROJECT_ID:?PROJECT_ID is required}
region=${REGION:-asia-northeast1}
read -r -a tf_command <<<"${TF:-terraform}"
shared_dir=infra/envs/shared
kms_source="$shared_dir/kms.tf"
state_bucket="${project_id}-tfstate"
status=0

say() { printf '[adopt-kms] %s\n' "$*"; }
warn() { printf '[adopt-kms] WARNING: %s\n' "$*" >&2; }

"${tf_command[@]}" -chdir="$shared_dir" init -input=false -reconfigure -backend-config="bucket=$state_bucket" >/dev/null
state_list=$("${tf_command[@]}" -chdir="$shared_dir" state list 2>/dev/null || true)

in_state() { grep -Fxq "$1" <<<"$state_list"; }

adopt() {
  local address=$1 id=$2
  if in_state "$address"; then return 0; fi
  say "adopting $id"
  "${tf_command[@]}" -chdir="$shared_dir" import -input=false \
    -var="project_id=$project_id" -var="region=$region" "$address" "$id" >/dev/null
}

# The version the crypto key was created with. Restoring is only possible inside
# destroy_scheduled_duration; past that the version is gone and so is the key's usefulness.
require_first_version() {
  local ring=$1 key=$2 state
  state=$(gcloud kms keys versions describe 1 --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --format='value(state)' 2>/dev/null) || {
    warn "$ring/$key has no version 1"
    status=1
    return
  }
  case "$state" in
    ENABLED) return 0 ;;
    DESTROY_SCHEDULED)
      say "restoring $ring/$key version 1, which was scheduled for destruction"
      gcloud kms keys versions restore 1 --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --quiet >/dev/null
      # A restore lands in DISABLED, which still cannot sign or decrypt.
      gcloud kms keys versions enable 1 --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --quiet >/dev/null
      ;;
    DISABLED)
      say "enabling $ring/$key version 1"
      gcloud kms keys versions enable 1 --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --quiet >/dev/null
      ;;
    *)
      warn "$ring/$key version 1 is $state and cannot be restored; deploy to a new project, or rename the key in $kms_source"
      status=1
      ;;
  esac
}

adopt_key() {
  local address=$1 ring=$2 key=$3
  gcloud kms keys describe "$key" --keyring="$ring" --location="$region" --project="$project_id" >/dev/null 2>&1 || return 0
  adopt "$address" "projects/$project_id/locations/$region/keyRings/$ring/cryptoKeys/$key"
  require_first_version "$ring" "$key"
}

# The rings and keys are read from the state's own source, so the two cannot drift apart.
while IFS= read -r ring; do
  [[ -n "$ring" ]] || continue
  gcloud kms keyrings describe "$ring" --location="$region" --project="$project_id" >/dev/null 2>&1 || continue
  adopt "google_kms_key_ring.rings[\"$ring\"]" "projects/$project_id/locations/$region/keyRings/$ring"
done < <(sed -n '/key_rings = toset(\[/,/\])/p' "$kms_source" | sed -nE 's/^[[:space:]]*"([a-z-]+)",?$/\1/p')

idjag_block=$(sed -n '/resource "google_kms_crypto_key" "shared_idjag"/,/^}/p' "$kms_source")
idjag_key=$(sed -nE 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' <<<"$idjag_block")
idjag_ring=$(sed -nE 's/.*rings\["([^"]+)"\].*/\1/p' <<<"$idjag_block")
[[ -n "$idjag_key" && -n "$idjag_ring" ]] || {
  echo "adopt-kms: could not read the signing key from $kms_source" >&2
  exit 2
}
adopt_key google_kms_crypto_key.shared_idjag "$idjag_ring" "$idjag_key"

while read -r name ring key; do
  [[ -n "$name" ]] || continue
  adopt_key "google_kms_crypto_key.symmetric[\"$name\"]" "$ring" "$key"
done < <(sed -nE 's/^[[:space:]]*([a-z_]+)[[:space:]]*=[[:space:]]*\{[[:space:]]*ring[[:space:]]*=[[:space:]]*"([^"]+)",[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1 \2 \3/p' "$kms_source")

if ((status == 0)); then
  say 'the project holds no KMS resource the shared state cannot use'
fi
exit "$status"
