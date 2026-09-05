#!/usr/bin/env bash
# reachability.sh asks GCP for an ID token in the name of every calling Service Account.
# A deploy identity that can create those Service Accounts still cannot speak as them:
# that needs roles/iam.serviceAccountTokenCreator on each one. This adds only what is
# missing, runs the command it was given, and takes the grants away again, so the
# permission exists for the length of the measurement and no longer.
#
# scripts/deploy-gcp-guide.sh does the same around its own verify step. Both skip an
# identity that already carries the binding and remove only what they added themselves,
# so running one inside the other neither grants twice nor revokes what the other needs.
set -uo pipefail

(($#)) || { echo 'verify-impersonation: usage: verify-impersonation.sh <command> [args...]' >&2; exit 2; }
command -v gcloud >/dev/null && command -v jq >/dev/null || { echo 'verify-impersonation: gcloud and jq are required' >&2; exit 2; }

demo_dir=${DEMO_TF_DIR:-infra/envs/demo}
read -r -a tf_command <<<"${TF:-terraform}"
project_id=${PROJECT_ID:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw project_id 2>/dev/null)}
[[ -n "$project_id" ]] || { echo 'verify-impersonation: PROJECT_ID is required' >&2; exit 2; }

principal=''
granted=()
revoke_bindings() {
  ((${#granted[@]})) || return 0
  local service_account
  for service_account in "${granted[@]}"; do
    gcloud iam service-accounts remove-iam-policy-binding "$service_account" \
      --project="$project_id" --member="$principal" \
      --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null 2>&1 ||
      echo "verify-impersonation: could not remove the temporary binding on $service_account" >&2
  done
  granted=()
}
trap revoke_bindings EXIT

# Who the measurement runs as. GitHub Actions impersonates the deploy Service Account
# through Workload Identity, where the active account is not always printed in the form
# IAM wants, so the workflow states it in VERIFY_PRINCIPAL.
account=${VERIFY_PRINCIPAL:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)}
case "$account" in
  user:* | serviceAccount:* | principal://* | principalSet://*) principal=$account ;;
  *.gserviceaccount.com) principal="serviceAccount:$account" ;;
  ?*@?*) principal="user:$account" ;;
  *) principal='' ;;
esac

if [[ -n "$principal" ]]; then
  edges=$("${tf_command[@]}" -chdir="$demo_dir" output -json invoker_edges 2>/dev/null) || edges='{}'
  existing=$(gcloud iam service-accounts list --project="$project_id" --format='value(email)' 2>/dev/null)
  # The callers reachability measures: every invoker edge, plus the callers of the denial
  # cases. An identity that does not exist is left out here and reported as skipped there.
  while IFS= read -r service_account; do
    [[ -n "$service_account" ]] || continue
    grep -Fxq "$service_account" <<<"$existing" || continue
    # Ask for a token rather than read the policy. That is the question being answered,
    # and it comes out right when the permission arrives from somewhere the service
    # account's own policy does not show, such as a grant made at the project.
    if gcloud auth print-identity-token --project="$project_id" \
      --impersonate-service-account="$service_account" --audiences="https://$project_id.invalid" >/dev/null 2>&1; then
      continue
    fi
    if gcloud iam service-accounts add-iam-policy-binding "$service_account" \
      --project="$project_id" --member="$principal" \
      --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null; then
      granted+=("$service_account")
    else
      printf 'verify-impersonation: %s cannot be granted roles/iam.serviceAccountTokenCreator on %s; grant it once by hand or give the runner roles/iam.serviceAccountAdmin\n' \
        "$principal" "$service_account" >&2
    fi
  done < <( {
    jq -r 'to_entries[].value.member | sub("^serviceAccount:"; "")' <<<"$edges"
    jq -r --arg project "$project_id" '.[] | select(.caller_sa != "") | .caller_sa + "@" + $project + ".iam.gserviceaccount.com"' infra/tests/reachability-cases.json
  } | sort -u)

  # A new binding takes up to a couple of minutes to take effect. Measuring before it does
  # reports every edge as unreachable, which reads like a broken deployment.
  ((${#granted[@]})) && for service_account in "${granted[@]}"; do
    for attempt in {1..36}; do
      gcloud auth print-identity-token --project="$project_id" \
        --impersonate-service-account="$service_account" --audiences="https://$project_id.invalid" >/dev/null 2>&1 && break
      if ((attempt == 36)); then
        echo "verify-impersonation: impersonating $service_account is still refused; measuring anyway" >&2
      else
        sleep 5
      fi
    done
  done
else
  echo 'verify-impersonation: cannot tell who is running; set VERIFY_PRINCIPAL to an IAM member such as serviceAccount:<email>' >&2
fi

"$@"
status=$?
revoke_bindings
exit "$status"
