#!/usr/bin/env bash
# The runner needs roles/iam.serviceAccountTokenCreator on each caller identity.
set -uo pipefail

command -v gcloud >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null || { echo 'reachability: gcloud, jq, and curl are required' >&2; exit 2; }
demo_dir=${DEMO_TF_DIR:-infra/envs/demo}
project_id=${PROJECT_ID:-$(terraform -chdir="$demo_dir" output -raw project_id 2>/dev/null)}
region=${REGION:-$(terraform -chdir="$demo_dir" output -raw region 2>/dev/null)}
[[ -n "$project_id" && -n "$region" ]] || { echo 'reachability: PROJECT_ID and REGION are required' >&2; exit 2; }

urls=$(terraform -chdir="$demo_dir" output -json service_urls 2>/dev/null) || { echo 'reachability: demo Terraform output is unavailable' >&2; exit 2; }
edges=$(terraform -chdir="$demo_dir" output -json invoker_edges 2>/dev/null) || { echo 'reachability: invoker_edges output is unavailable' >&2; exit 2; }
cases=$(jq -c '[to_entries[] | {caller_sa:(.value.member|sub("^serviceAccount:";"")|split("@")[0]), target:.value.service, path:"/healthz", expect:200}]' <<<"$edges")
cases=$(jq -c -s '.[0] + .[1]' <(printf '%s' "$cases") infra/tests/reachability-cases.json)

status=0
while IFS= read -r row; do
  caller=$(jq -r '.caller_sa' <<<"$row")
  target=$(jq -r '.target' <<<"$row")
  path=$(jq -r '.path' <<<"$row")
  expected=$(jq -r '.expect' <<<"$row")
  url=$(jq -r --arg target "$target" '.[$target] // empty' <<<"$urls")
  [[ -n "$url" ]] || url="https://${target}-${project_id}.${region}.run.app"
  headers=()
  if [[ -n "$caller" ]]; then
    email="${caller}@${project_id}.iam.gserviceaccount.com"
    token=$(gcloud auth print-identity-token --project="$project_id" --impersonate-service-account="$email" --audiences="$url" 2>/dev/null) || {
      echo 'reachability: roles/iam.serviceAccountTokenCreator is required' >&2
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
