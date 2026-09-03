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

# Whatever launched this, nothing below waits on a terminal. A gcloud prompt written to a
# stderr that is redirected away, or a terraform that decides to ask for a variable, looks
# to the caller like an invisible stop. Prompting is disabled, and then the terminal itself
# is taken away: any child that still reads stdin gets EOF instead of waiting. Pipes, here
# strings and process substitutions are explicit connections and keep working.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export TF_IN_AUTOMATION=1
export TF_INPUT=0
exec </dev/null

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

project_id=${PROJECT_ID:?PROJECT_ID is required}
region=${REGION:-asia-northeast1}
read -r -a tf_command <<<"${TF:-terraform}"
shared_dir=infra/envs/shared
kms_source="$shared_dir/kms.tf"
state_bucket="${project_id}-tfstate"
status=0

# Every step says what it is doing and how long the run has taken. Without that, the whole
# script is one silent gap in the deploy guide's output, which reads as a hang.
say() { printf '[adopt-kms %02d:%02d] %s\n' $((SECONDS / 60)) $((SECONDS % 60)) "$*"; }
warn() { printf '[adopt-kms] WARNING: %s\n' "$*" >&2; }

in_list() { grep -Fxq -- "$1" <<<"$2"; }

# The rings and keys are read from the state's own source, so the two cannot drift apart.
wanted_rings=$(sed -n '/key_rings = toset(\[/,/\])/p' "$kms_source" | sed -nE 's/^[[:space:]]*"([a-z-]+)",?$/\1/p')

idjag_block=$(sed -n '/resource "google_kms_crypto_key" "shared_idjag"/,/^}/p' "$kms_source")
idjag_key=$(sed -nE 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' <<<"$idjag_block")
idjag_ring=$(sed -nE 's/.*rings\["([^"]+)"\].*/\1/p' <<<"$idjag_block")
[[ -n "$idjag_key" && -n "$idjag_ring" ]] || {
  echo "adopt-kms: could not read the signing key from $kms_source" >&2
  exit 2
}

# "<terraform address> <ring> <key>" per line, the signing key first.
wanted_keys="google_kms_crypto_key.shared_idjag $idjag_ring $idjag_key"$'\n'
while read -r name ring key; do
  [[ -n "$name" ]] || continue
  wanted_keys+="google_kms_crypto_key.symmetric[\"$name\"] $ring $key"$'\n'
done < <(sed -nE 's/^[[:space:]]*([a-z_]+)[[:space:]]*=[[:space:]]*\{[[:space:]]*ring[[:space:]]*=[[:space:]]*"([^"]+)",[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1 \2 \3/p' "$kms_source")

# What has to be adopted is decided from GCP first, because that answer is two API calls
# while `terraform init` plus a state read is minutes on a cold provider cache. A project
# that holds no KMS resource — every first deploy — leaves here without touching Terraform.
if enabled=$(gcloud services list --enabled --project="$project_id" \
  --filter='config.name=cloudkms.googleapis.com' --format='value(config.name)' 2>/dev/null); then
  if [[ -z "$enabled" ]]; then
    say 'cloudkms.googleapis.com is not enabled, so the project holds no KMS resource'
    exit 0
  fi
fi

say "listing the key rings in $region"
existing_rings=$(gcloud kms keyrings list --location="$region" --project="$project_id" \
  --format='value(name.basename())' 2>/dev/null || true)

# "<terraform address> <resource id>" per line: everything the shared state should own that
# the project already holds.
adoptable=''
present_rings=''
while IFS= read -r ring; do
  [[ -n "$ring" ]] || continue
  in_list "$ring" "$existing_rings" || continue
  present_rings+="$ring"$'\n'
  adoptable+="google_kms_key_ring.rings[\"$ring\"] projects/$project_id/locations/$region/keyRings/$ring"$'\n'
done <<<"$wanted_rings"

# One list call per ring that exists, rather than one describe call per key the source names.
existing_keys=''
while IFS= read -r ring; do
  [[ -n "$ring" ]] || continue
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    existing_keys+="$ring/$key"$'\n'
  done < <(gcloud kms keys list --keyring="$ring" --location="$region" --project="$project_id" \
    --format='value(name.basename())' 2>/dev/null || true)
done <<<"$present_rings"

present_keys=''
while read -r address ring key; do
  [[ -n "$address" ]] || continue
  in_list "$ring/$key" "$existing_keys" || continue
  present_keys+="$address $ring $key"$'\n'
  adoptable+="$address projects/$project_id/locations/$region/keyRings/$ring/cryptoKeys/$key"$'\n'
done <<<"$wanted_keys"

if [[ -z "${adoptable//[$'\n']/}" ]]; then
  say 'the project holds no KMS resource the shared state would own'
  exit 0
fi

# Only now is Terraform needed, and only to answer "which of these is already in state".
say "reading the shared state (a cold provider cache makes this init take a few minutes)"
"${tf_command[@]}" -chdir="$shared_dir" init -input=false -reconfigure \
  -backend-config="bucket=$state_bucket" >/dev/null
state_list=$("${tf_command[@]}" -chdir="$shared_dir" state list 2>/dev/null || true)

pending=''
while read -r address id; do
  [[ -n "$address" ]] || continue
  in_list "$address" "$state_list" && continue
  pending+="$address $id"$'\n'
done <<<"$adoptable"

pending_count=$(grep -c . <<<"$pending" || true)
if ((pending_count > 0)); then
  say "$pending_count resource(s) exist in GCP and are missing from state; each import takes ~10-30s"
  index=0
  while read -r address id; do
    [[ -n "$address" ]] || continue
    index=$((index + 1))
    say "[$index/$pending_count] importing $id"
    "${tf_command[@]}" -chdir="$shared_dir" import -input=false -lock-timeout=120s \
      -var="project_id=$project_id" -var="region=$region" "$address" "$id" >/dev/null
  done <<<"$pending"
  say "imported $pending_count resource(s)"
else
  say 'the shared state already owns every KMS resource the project holds'
fi

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

key_count=$(grep -c . <<<"$present_keys" || true)
if ((key_count > 0)); then
  say "checking version 1 of $key_count crypto key(s)"
  while read -r address ring key; do
    [[ -n "$address" ]] || continue
    require_first_version "$ring" "$key"
  done <<<"$present_keys"
fi

if ((status == 0)); then
  say 'the project holds no KMS resource the shared state cannot use'
fi
exit "$status"
