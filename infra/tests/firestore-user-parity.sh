#!/usr/bin/env bash
set -euo pipefail

# The two lists that say which apps may reach Firestore, held together.
#
# `packages/gcp/src/access-matrix.json` names the collections each app may read and
# write, and `firestore-guard` enforces it inside the process. `datastore_users` in
# iam-project.tf grants `roles/datastore.user` to the Service Accounts those apps run
# as. The first list is what the code believes; the second is what Google allows. An
# app in the first and not the second passes its own guard and is refused by IAM.
#
# They were not the same set. Both Resource AS declared `oidc_resource_*_as`,
# `dpop_jti`, `assertion_jti` and `revoked_actors`, and neither held the role. The
# first Firestore call on a redemption is the DPoP `jti` write inside verifyDpopProof,
# so the denial arrived as `dpop_key_binding_mismatch` — a refusal that names a key
# mismatch — on a proof whose `htu` and thumbprint both matched. Nothing measured it:
# every test runs the AS against an in-memory jti store and no Firestore at all.
#
# The mapping is not written here. locals-services.tf already carries `image_app`
# (service -> the app name the matrix uses) and `service_sa_key` (service -> the
# Service Account key), and jobs.tf pairs each Job's image with its Service Account.
# This reads all three rather than keeping a fourth list to drift.

matrix=packages/gcp/src/access-matrix.json
locals_services=infra/envs/demo/locals-services.tf
jobs=infra/envs/demo/jobs.tf
iam_project=infra/envs/demo/iam-project.tf
for file in "$matrix" "$locals_services" "$jobs" "$iam_project"; do
  [[ -f "$file" ]] || { echo "firestore-user-parity: missing $file" >&2; exit 1; }
done

# `name = "value",` pairs inside one Terraform map block.
read_map() {
  sed -n "/^  $1 = {/,/^  }/p" "$locals_services" \
    | grep -oE '[a-z0-9-]+ += +"[a-z0-9_-]+"' | sed -E 's/ += +"/ /; s/"$//'
}

apps_with_collections=$(python3 -c '
import json, sys
matrix = json.load(open(sys.argv[1]))
for app, access in sorted(matrix.items()):
    if access.get("read") or access.get("write"):
        print(app)
' "$matrix")

# `app account` for every Job: the image names the app, the next service_account line
# names the identity it runs as. Agent Runtime and seed are Jobs (DEC-APP-02), so
# neither appears in the service tables above.
read_jobs() {
  awk '
    /image[ ]*=/ { n = split($0, a, "/"); split(a[n], b, ":"); app = b[1] }
    /service_account[ ]*=/ {
      if (app != "" && match($0, /"[a-z0-9_]+"/)) { print app, substr($0, RSTART + 1, RLENGTH - 2); app = "" }
    }
  ' "$jobs"
}

# app -> service account, from the service tables and the Job blocks alike.
declare -A app_of sa_of account_of
while read -r service app; do [[ -n "$service" ]] && app_of["$service"]="$app"; done <<< "$(read_map image_app)"
while read -r service key; do [[ -n "$service" ]] && sa_of["$service"]="$key"; done <<< "$(read_map service_sa_key)"

[[ ${#app_of[@]} -gt 0 ]] || { echo 'firestore-user-parity: read no image_app entry' >&2; exit 1; }
[[ ${#sa_of[@]} -gt 0 ]] || { echo 'firestore-user-parity: read no service_sa_key entry' >&2; exit 1; }

for service in "${!app_of[@]}"; do
  key="${sa_of[$service]:-}"
  [[ -n "$key" ]] || { echo "firestore-user-parity: $service has no service_sa_key entry" >&2; exit 1; }
  account_of["${app_of[$service]}"]="$key"
done
while read -r app key; do [[ -n "$app" ]] && account_of["$app"]="$key"; done <<< "$(read_jobs)"

required=$(while read -r app; do
  [[ -n "$app" ]] || continue
  key="${account_of[$app]:-}"
  [[ -n "$key" ]] || { echo "firestore-user-parity: the matrix declares $app, which no service or job runs" >&2; exit 1; }
  echo "$key"
done <<< "$apps_with_collections" | sort -u)

granted=$(sed -n '/datastore_users = toset(\[/,/\])/p' "$iam_project" \
  | grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort -u)

[[ -n "$required" ]] || { echo 'firestore-user-parity: derived no required account' >&2; exit 1; }
[[ -n "$granted" ]] || { echo 'firestore-user-parity: read no datastore_users entry' >&2; exit 1; }

if ! diff -u <(echo "$required") <(echo "$granted") >/dev/null; then
  echo 'firestore-user-parity: the access matrix and roles/datastore.user disagree' >&2
  diff -u --label 'access-matrix.json (apps declaring a collection)' \
    --label 'iam-project.tf (datastore_users)' \
    <(echo "$required") <(echo "$granted") >&2 || true
  exit 1
fi

echo 'firestore-user-parity: every app that declares a collection holds roles/datastore.user'
