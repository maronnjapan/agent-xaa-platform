#!/usr/bin/env bash
set -uo pipefail

command -v gcloud >/dev/null && command -v jq >/dev/null || { echo 'invoker-matrix: gcloud and jq are required' >&2; exit 2; }
demo_dir=${DEMO_TF_DIR:-infra/envs/demo}
read -r -a tf_command <<<"${TF:-terraform}"
project_id=${PROJECT_ID:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw project_id 2>/dev/null)}
region=${REGION:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw region 2>/dev/null)}
[[ -n "$project_id" && -n "$region" ]] || { echo 'invoker-matrix: PROJECT_ID and REGION are required' >&2; exit 2; }
edges=$("${tf_command[@]}" -chdir="$demo_dir" output -json invoker_edges 2>/dev/null) || { echo 'invoker-matrix: invoker_edges output unavailable' >&2; exit 2; }
public=$("${tf_command[@]}" -chdir="$demo_dir" output -json public_services 2>/dev/null) || { echo 'invoker-matrix: public_services output unavailable' >&2; exit 2; }

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT
jq -r 'to_entries[] | [.value.member, .value.service] | @tsv' <<<"$edges" | sort -u >"$temp_dir/expected-private"
jq -r '.[] | ["allUsers", .] | @tsv' <<<"$public" | sort -u >"$temp_dir/expected-public"
: >"$temp_dir/actual-private"
: >"$temp_dir/actual-public"

while IFS= read -r service; do
  policy=$(gcloud run services get-iam-policy "$service" --project="$project_id" --region="$region" --format=json) || exit 2
  while IFS= read -r member; do
    if [[ "$member" == allUsers ]]; then
      printf '%s\t%s\n' "$member" "$service" >>"$temp_dir/actual-public"
    else
      printf '%s\t%s\n' "$member" "$service" >>"$temp_dir/actual-private"
    fi
  done < <(jq -r '.bindings[]? | select(.role=="roles/run.invoker") | .members[]?' <<<"$policy")
done < <(gcloud run services list --project="$project_id" --region="$region" --format='value(metadata.name)')
sort -u -o "$temp_dir/actual-private" "$temp_dir/actual-private"
sort -u -o "$temp_dir/actual-public" "$temp_dir/actual-public"

status=0
report_diff() {
  local label=$1 expected_file=$2 actual_file=$3
  while IFS=$'\t' read -r caller target; do
    [[ -n "$caller" ]] || continue
    printf '%s-extra / %s / %s\n' "$label" "$caller" "$target" >&2
    status=1
  done < <(comm -13 "$expected_file" "$actual_file")
  while IFS=$'\t' read -r caller target; do
    [[ -n "$caller" ]] || continue
    printf '%s-missing / %s / %s\n' "$label" "$caller" "$target" >&2
    status=1
  done < <(comm -23 "$expected_file" "$actual_file")
}
report_diff private "$temp_dir/expected-private" "$temp_dir/actual-private"
report_diff public "$temp_dir/expected-public" "$temp_dir/actual-public"

# `sa-agent-runtime` is the one shared runtime identity and `sa-agent-<short>` is a
# FULL_ISOLATION Agent's own: the two carry opposite rules, and the shared one is not a
# case of the pattern that matches the per-Agent ones.
while IFS=$'\t' read -r member target; do
  caller=${member#serviceAccount:}; caller=${caller%%@*}
  agent_short=''
  [[ "$caller" != sa-agent-runtime && "$caller" =~ ^sa-agent-(.+)$ ]] && agent_short=${BASH_REMATCH[1]}
  if { [[ "$caller" == sa-agent-runtime && "$target" == dedicated-op-* ]]; } ||
     { [[ -n "$agent_short" && "$target" == shared-agent-op ]]; } ||
     { [[ -n "$agent_short" && "$target" == dedicated-idjag-* && "$target" != "dedicated-idjag-$agent_short" ]]; }; then
    printf 'forbidden-edge / %s / %s\n' "$caller" "$target" >&2
    status=1
  fi
done <"$temp_dir/actual-private"
exit "$status"
