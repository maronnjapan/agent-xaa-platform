#!/usr/bin/env bash
# The runner needs roles/iam.serviceAccountTokenCreator on each caller identity.
# `make verify` goes through scripts/verify-impersonation.sh, which adds what is missing
# for the length of the measurement and removes it again.
set -uo pipefail

command -v gcloud >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null || { echo 'reachability: gcloud, jq, and curl are required' >&2; exit 2; }
demo_dir=${DEMO_TF_DIR:-infra/envs/demo}
read -r -a tf_command <<<"${TF:-terraform}"
project_id=${PROJECT_ID:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw project_id 2>/dev/null)}
region=${REGION:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw region 2>/dev/null)}
[[ -n "$project_id" && -n "$region" ]] || { echo 'reachability: PROJECT_ID and REGION are required' >&2; exit 2; }

urls=$("${tf_command[@]}" -chdir="$demo_dir" output -json service_urls 2>/dev/null) || { echo 'reachability: demo Terraform output is unavailable' >&2; exit 2; }
edges=$("${tf_command[@]}" -chdir="$demo_dir" output -json invoker_edges 2>/dev/null) || { echo 'reachability: invoker_edges output is unavailable' >&2; exit 2; }
cases=$(jq -c '[to_entries[] | {caller_sa:(.value.member|sub("^serviceAccount:";"")|split("@")[0]), target:.value.service, path:"/livez", expect:200}]' <<<"$edges")
cases=$(jq -c -s '.[0] + .[1]' <(printf '%s' "$cases") infra/tests/reachability-cases.json)

# Three of the denial cases name a FULL_ISOLATION Agent's own identity and Dedicated OP
# (`sa-agent-aaaaaaaaaaaa`, `dedicated-op-bbbbbbbbbbbb`). The Provisioner creates those at
# run time (DEC-IAC-07), so a project that has never provisioned such an Agent holds
# neither, and measuring them there says nothing about IAM: the token request fails
# because the identity does not exist, and the call answers 404 because no service serves
# that host. A case whose caller or target is absent is reported as skipped.
accounts=$(gcloud iam service-accounts list --project="$project_id" --format='value(email)') || { echo 'reachability: the project service accounts cannot be listed' >&2; exit 2; }
# Ingress decides what can be measured from here at all. This project has no VPC, so a
# service with internal ingress answers 404 at the Google front end before
# `roles/run.invoker` is read (infra/spike/RESULT.md (a)), and a runner outside the
# project only ever gets that 404. Measuring such a target would say nothing about IAM.
deployed=$(gcloud run services list --project="$project_id" --region="$region" \
  --format='csv[no-heading](metadata.name,metadata.annotations."run.googleapis.com/ingress",status.url)') || { echo 'reachability: the deployed services cannot be listed' >&2; exit 2; }

status=0
while IFS= read -r row; do
  caller=$(jq -r '.caller_sa' <<<"$row")
  target=$(jq -r '.target' <<<"$row")
  path=$(jq -r '.path' <<<"$row")
  expected=$(jq -r '.expect' <<<"$row")
  row=$(awk -F, -v name="$target" '$1 == name { print; exit }' <<<"$deployed")
  if [[ -z "$row" ]]; then
    printf 'reachability / %s / %s / skipped: the service is not deployed\n' "${caller:-anonymous}" "$target"
    continue
  fi
  IFS=, read -r _ ingress observed <<<"$row"
  if [[ "$ingress" == internal* ]]; then
    printf 'reachability / %s / %s / skipped: ingress=%s answers 404 to every caller outside the project\n' "${caller:-anonymous}" "$target" "$ingress"
    continue
  fi
  # Terraform's URL first, and not only because it is at hand: DEC-IAC-05 computes it from
  # the project number rather than reading it back, so calling the computed URL is what
  # measures the formula. A service Terraform knows nothing about — a Dedicated OP the
  # Provisioner made — is called at the URL Cloud Run reports for it instead.
  url=$(jq -r --arg target "$target" '.[$target] // empty' <<<"$urls")
  [[ -n "$url" ]] || url=$observed
  if [[ -z "$url" ]]; then
    printf 'reachability / %s / %s / skipped: the service reports no URL\n' "${caller:-anonymous}" "$target"
    continue
  fi
  headers=()
  if [[ -n "$caller" ]]; then
    email="${caller}@${project_id}.iam.gserviceaccount.com"
    if ! grep -Fxq "$email" <<<"$accounts"; then
      printf 'reachability / %s / %s / skipped: the service account does not exist\n' "$caller" "$target"
      continue
    fi
    token=$(gcloud auth print-identity-token --project="$project_id" --impersonate-service-account="$email" --audiences="$url" 2>/dev/null) || {
      printf 'reachability: %s cannot be impersonated; roles/iam.serviceAccountTokenCreator on it is required\n' "$email" >&2
      exit 2
    }
    headers=(-H "Authorization: Bearer $token")
  fi
  actual=$(curl -sS -o /dev/null -w '%{http_code}' "${headers[@]}" "$url$path" || true)
  if [[ "$actual" != "$expected" ]]; then
    printf 'reachability / %s / %s / expected=%s / actual=%s\n' "${caller:-anonymous}" "$target" "$expected" "$actual" >&2
    status=1
  fi
done < <(jq -c '.[]' <<<"$cases")
exit "$status"
