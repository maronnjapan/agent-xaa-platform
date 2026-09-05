#!/usr/bin/env bash
# T-IAC-16. `allUsers` holds `roles/run.invoker` on exactly `locals.public_services`, and
# `INGRESS_TRAFFIC_ALL` is given to exactly that set plus the services another Cloud Run
# service or job calls (`locals.run_called_services`, derived from `invoker_edge_pairs`).
# The two sets stopped being the same set once the spike was actually run: without a VPC,
# internal-only ingress answers a Cloud Run to Cloud Run call with 404 before
# `roles/run.invoker` is consulted (infra/spike/RESULT.md, DEC-IAC-14). Open ingress is
# therefore not public access — `allUsers` is still confined to the set below.
#
# The check is static rather than plan-based so it runs with no credentials; what makes
# that sound is that both sets are *derived* in one expression each, so this file
# verifies the derivation instead of the plan output.
set -euo pipefail

services=infra/envs/demo/services.tf
locals_file=infra/envs/demo/locals-services.tf
public_iam=infra/envs/demo/iam-public.tf

expected=(automation-app human-idp agent-op-callback google-bridge-callback stub-saas-op)

# 1. `public_services` names exactly the five services that may face the internet.
block=$(sed -n '/public_services = setunion(/,/^  )/p' "$locals_file")
[[ -n "$block" ]] || { echo 'public-surface: locals.public_services is missing' >&2; exit 1; }
# Only the service names inside `toset([...])` are members of the set; the bare strings
# elsewhere in the block are the values `saas_connector_mode` is compared against.
mapfile -t declared < <(grep -oE 'toset\(\[[^]]*\]' <<<"$block" | grep -oE '"[a-z-]+"' | tr -d '"' | sort -u)
mapfile -t wanted < <(printf '%s\n' "${expected[@]}" | sort -u)
status=0
while IFS= read -r name; do
  printf 'public-surface / extra / %s\n' "$name" >&2
  status=1
done < <(comm -13 <(printf '%s\n' "${wanted[@]}") <(printf '%s\n' "${declared[@]}"))
while IFS= read -r name; do
  printf 'public-surface / missing / %s\n' "$name" >&2
  status=1
done < <(comm -23 <(printf '%s\n' "${wanted[@]}") <(printf '%s\n' "${declared[@]}"))
((status == 0)) || { echo 'public-surface: locals.public_services is not the documented set' >&2; exit 1; }

# 2. Ingress is decided by one expression, and that expression is exactly this one.
# Matching the whole expression rather than a substring is what makes a per-service
# override (`name == "authorization" ? "INGRESS_TRAFFIC_ALL" : <the derivation>`) fail
# here instead of slipping through on the strength of the derivation it wraps.
canonical='ingress = contains(local.ingress_all_services, name) ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"'
seen=0
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  body=${line#*:}  # drop the path
  body=${body#*:}  # drop the line number
  body=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+/ /g; s/[[:space:]]+$//' <<<"$body")
  if [[ "${line%%:*}" == "$services" && "$body" == "$canonical" ]]; then
    seen=$((seen + 1))
    continue
  fi
  printf 'public-surface / ingress-outside-derivation / %s\n' "$line" >&2
  status=1
done < <(find infra/envs infra/modules -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -n 'INGRESS_TRAFFIC_ALL' || true)
((seen == 1)) || {
  echo 'public-surface: ingress must be derived from locals.public_services exactly once' >&2
  status=1
}

# 2b. And that set is the public one widened by the invoker edges alone. Reading it out
# of `invoker_edge_pairs` is what keeps a service from being opened by hand: a name only
# reaches ingress ALL by first appearing as the target of an edge some Cloud Run caller
# holds, which is the same table `roles/run.invoker` is generated from.
grep -qF 'ingress_all_services = setunion(local.public_services, local.run_called_services)' "$locals_file" || {
  echo 'public-surface: ingress_all_services must be public_services widened by run_called_services' >&2
  status=1
}
grep -qF 'for pair in local.invoker_edge_pairs : pair[1] if contains(local.run_callers, pair[0])' "$locals_file" || {
  echo 'public-surface: run_called_services must be derived from local.invoker_edge_pairs' >&2
  status=1
}

# 3. allUsers invoker is generated from the same set, and from nowhere else.
grep -qF 'for_each = local.public_services' "$public_iam" || {
  echo 'public-surface: the allUsers invoker must be generated from locals.public_services' >&2
  exit 1
}
foreign=$(find infra/envs -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -l 'allUsers' | grep -v "^$public_iam$" || true)
[[ -z "$foreign" ]] || {
  echo "public-surface: allUsers belongs in $public_iam, found in: $foreign" >&2
  exit 1
}

# 4. No VPC anywhere, and the module default stays internal.
if find infra -name '*.tf' -not -path '*/.terraform/*' -print0 | xargs -0 -r grep -nE 'google_(compute_)?(network|subnetwork|vpc_access_connector)|vpc_access'; then
  echo 'public-surface: VPC resources are outside the single-project demo design' >&2
  exit 1
fi
grep -qE 'INGRESS_TRAFFIC_INTERNAL_ONLY' infra/modules/cloud-run-service/variables.tf || {
  echo 'public-surface: internal ingress must be the module default' >&2
  exit 1
}
exit "$status"
