#!/usr/bin/env bash
# Remove every resource this repository creates inside the one GCP project and leave the
# project itself. `make demo-destroy` only reaches the demo state; three groups survive it
# by design, and this script is what takes them:
#
#   1. the Dedicated OP resources the Provisioner creates at runtime, which were never in
#      any Terraform state (scripts/purge-runtime-resources.sh);
#   2. the shared state, whose KMS resources carry prevent_destroy because GCP never
#      deletes a key ring or a crypto key. They are dropped from state so the rest of the
#      state can go; whether their key versions go with them is DESTROY_KMS_KEY_VERSIONS,
#      explained where it is read below;
#   3. the state bucket, which cannot be destroyed by the Terraform run that reads it.
#
# Terraform failures stop the script. The gcloud sweeps are best effort, because a half
# destroyed project is exactly the case this has to survive; what is actually left is
# measured at the end by infra/tests/destroy-all-residue.sh.
set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

project_id=${PROJECT_ID:?PROJECT_ID is required}
region=${REGION:-asia-northeast1}
read -r -a tf_command <<<"${TF:-terraform}"
demo_tfvars=${DEMO_TFVARS:-infra/tfvars/deploy.tfvars}
# Only the plan needs an image tag; nothing that gets destroyed is built from it.
image_tag=${IMAGE_TAG:-destroy}
state_bucket="${project_id}-tfstate"
case "${DELETE_STATE_BUCKET:-1}" in
  1 | true | yes) delete_state_bucket=1 ;;
  *) delete_state_bucket=0 ;;
esac
# Off by default, and the only irreversible thing here. GCP cannot delete a key ring or a
# crypto key, so a destroyed version cannot be replaced by an equivalent one: DEC-IAC-04
# fixes the platform on version 1, and once that version passes its scheduled destruction
# the project can never run the platform again. Five versions cost a few tens of yen a
# month, which is the price of keeping the project redeployable. Turn it on for a project
# that is being abandoned rather than emptied.
case "${DESTROY_KMS_KEY_VERSIONS:-0}" in
  1 | true | yes) destroy_kms_key_versions=1 ;;
  *) destroy_kms_key_versions=0 ;;
esac

say() { printf '\n[destroy-all] %s\n' "$*"; }
warn() { printf '[destroy-all] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[destroy-all] ERROR: %s\n' "$*" >&2
  exit 1
}

delete_each() {
  # delete_each <label> <delete command...> --- <list command...>
  local label=$1 target
  shift
  local -a delete_command=()
  while (($#)); do
    [[ "$1" == '---' ]] && {
      shift
      break
    }
    delete_command+=("$1")
    shift
  done
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    printf '[destroy-all] %s: %s\n' "$label" "$target"
    "${delete_command[@]}" "$target" >/dev/null 2>&1 || warn "could not delete $label $target"
  done < <("$@" 2>/dev/null)
}

list_datasets() {
  command -v bq >/dev/null 2>&1 || return 0
  bq --project_id="$project_id" --format=json ls --datasets 2>/dev/null | jq -r '.[]?.datasetReference.datasetId'
}

list_buckets() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" && "$name" != "$state_bucket" ]] || continue
    printf 'gs://%s\n' "$name"
  done < <(gcloud storage buckets list --project="$project_id" --format='value(name)' 2>/dev/null)
}

say "Target project $project_id in $region"

# --- 1. runtime-owned resources -------------------------------------------------------
# The Provisioner creates these outside Terraform, so the demo destroy below would leave
# them behind, and the service accounts they run as cannot be released while they exist.
say 'Deleting the Dedicated OP resources the Provisioner created'
PROJECT_ID="$project_id" REGION="$region" bash scripts/purge-runtime-resources.sh \
  || warn 'the runtime purge did not finish; the sweep below covers what is left'

# --- 2. Terraform states, demo before shared ------------------------------------------
# The demo state reads the shared state, so the order is not interchangeable.
if gcloud storage buckets describe "gs://$state_bucket" >/dev/null 2>&1; then
  demo_vars=(-var="project_id=$project_id" -var="region=$region" -var="image_tag=$image_tag")
  [[ -f "$demo_tfvars" ]] && demo_vars=(-var-file="$repo_root/$demo_tfvars" "${demo_vars[@]}")

  say 'Destroying the demo state'
  "${tf_command[@]}" -chdir=infra/envs/demo init -input=false -reconfigure -backend-config="bucket=$state_bucket" \
    || die 'demo init failed'
  "${tf_command[@]}" -chdir=infra/envs/demo destroy -input=false -auto-approve "${demo_vars[@]}" \
    || die 'demo destroy failed'

  say 'Destroying the shared state'
  "${tf_command[@]}" -chdir=infra/envs/shared init -input=false -reconfigure -backend-config="bucket=$state_bucket" \
    || die 'shared init failed'
  # prevent_destroy on the KMS resources exists because GCP cannot delete them at all, so
  # a plan that includes them can only fail. Dropping them from state lets the rest of the
  # shared state go, and step 3 destroys the key versions, which is the part that holds
  # key material and the part that is billed.
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    say "Dropping the undeletable $address from state"
    "${tf_command[@]}" -chdir=infra/envs/shared state rm "$address" || die "state rm $address failed"
  done < <("${tf_command[@]}" -chdir=infra/envs/shared state list 2>/dev/null | grep -E '^google_kms_(key_ring|crypto_key)\.')
  "${tf_command[@]}" -chdir=infra/envs/shared destroy -input=false -auto-approve \
    -var="project_id=$project_id" -var="region=$region" \
    || die 'shared destroy failed'
else
  warn "gs://$state_bucket is missing, so there is no state to destroy; sweeping the project instead"
fi

# --- 3. KMS key versions --------------------------------------------------------------
# Scheduled destruction is the only deletion GCP offers here. The ring and the key stay
# for the life of the project either way. The key versions the Provisioner created were
# already destroyed in step 1, because an agent's key is disposable; these are the five
# the shared state created, which are not.
if ((destroy_kms_key_versions)); then
  say 'Scheduling destruction of every remaining KMS key version'
  while IFS= read -r ring; do
    [[ -n "$ring" ]] || continue
    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      while IFS= read -r version; do
        [[ -n "$version" ]] || continue
        printf '[destroy-all] kms key version: %s/%s/%s\n' "$ring" "$key" "$version"
        gcloud kms keys versions destroy "$version" --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --quiet >/dev/null 2>&1 \
          || warn "could not schedule destruction of $ring/$key/$version"
      done < <(gcloud kms keys versions list --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --filter='state=ENABLED OR state=DISABLED' --format='value(name.basename())' 2>/dev/null)
    done < <(gcloud kms keys list --keyring="$ring" --location="$region" --project="$project_id" --format='value(name.basename())' 2>/dev/null)
  done < <(gcloud kms keyrings list --location="$region" --project="$project_id" --format='value(name.basename())' 2>/dev/null)
else
  say 'Keeping the five shared KMS key versions, which is what leaves the project redeployable'
fi

# --- 4. sweep what state could not account for ----------------------------------------
# Everything below is already gone after a clean pair of destroys. It runs anyway so a
# project whose state was lost, or whose apply failed halfway, still ends up empty.
say 'Sweeping resources the states could not account for'
delete_each 'cloud run service' \
  gcloud run services delete --project="$project_id" --region="$region" --quiet \
  --- gcloud run services list --project="$project_id" --region="$region" --format='value(metadata.name)'
delete_each 'cloud run job' \
  gcloud run jobs delete --project="$project_id" --region="$region" --quiet \
  --- gcloud run jobs list --project="$project_id" --region="$region" --format='value(metadata.name)'
delete_each 'scheduler job' \
  gcloud scheduler jobs delete --project="$project_id" --location="$region" --quiet \
  --- gcloud scheduler jobs list --project="$project_id" --location="$region" --format='value(name.basename())'
delete_each 'pubsub subscription' \
  gcloud pubsub subscriptions delete --project="$project_id" --quiet \
  --- gcloud pubsub subscriptions list --project="$project_id" --format='value(name.basename())'
delete_each 'pubsub topic' \
  gcloud pubsub topics delete --project="$project_id" --quiet \
  --- gcloud pubsub topics list --project="$project_id" --format='value(name.basename())'
delete_each 'firestore database' \
  gcloud firestore databases delete --project="$project_id" --quiet --database \
  --- gcloud firestore databases list --project="$project_id" --format='value(name.basename())'
delete_each 'secret' \
  gcloud secrets delete --project="$project_id" --quiet \
  --- gcloud secrets list --project="$project_id" --format='value(name.basename())'
delete_each 'artifact registry repository' \
  gcloud artifacts repositories delete --project="$project_id" --location="$region" --quiet \
  --- gcloud artifacts repositories list --project="$project_id" --location="$region" --format='value(name.basename())'
delete_each 'logging sink' \
  gcloud logging sinks delete --project="$project_id" --quiet \
  --- gcloud logging sinks list --project="$project_id" --filter='name!=_Default AND name!=_Required' --format='value(name)'
delete_each 'custom role' \
  gcloud iam roles delete --project="$project_id" --quiet \
  --- gcloud iam roles list --project="$project_id" --format='value(name.basename())'
# Platform and runtime service accounts share the sa- prefix; the Google-managed default
# accounts do not carry it and are not ours to delete.
delete_each 'service account' \
  gcloud iam service-accounts delete --project="$project_id" --quiet \
  --- gcloud iam service-accounts list --project="$project_id" --filter='email ~ ^sa-' --format='value(email)'
delete_each 'bucket' \
  gcloud storage rm --recursive --all-versions --quiet \
  --- list_buckets
delete_each 'bigquery dataset' \
  bq --project_id="$project_id" rm --dataset --recursive --force \
  --- list_datasets

# --- 5. the state bucket --------------------------------------------------------------
if ((delete_state_bucket)); then
  say "Deleting gs://$state_bucket, which held the states destroyed above"
  # Versioning is on, so the noncurrent generations have to go before the bucket will.
  gcloud storage rm --recursive --all-versions "gs://$state_bucket/**" --quiet >/dev/null 2>&1
  gcloud storage buckets delete "gs://$state_bucket" --quiet >/dev/null 2>&1 \
    || warn "could not delete gs://$state_bucket"
else
  say "Keeping gs://$state_bucket"
fi

# --- 6. what is actually left ---------------------------------------------------------
say 'Measuring what the project still holds'
PROJECT_ID="$project_id" REGION="$region" \
  KEEP_STATE_BUCKET=$((1 - delete_state_bucket)) \
  KEEP_KMS_KEY_VERSIONS=$((1 - destroy_kms_key_versions)) \
  bash infra/tests/destroy-all-residue.sh
status=$?
if ((status == 0)); then
  say 'Nothing is left but the KMS resources GCP never deletes'
fi
exit "$status"
