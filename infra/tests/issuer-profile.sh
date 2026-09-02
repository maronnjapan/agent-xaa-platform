#!/usr/bin/env bash
# T-IAC-17. Both issuer profiles, checked without credentials.
#
# `direct`: no google_compute_* resource may reach the demo state at all, so the check is
# that every one of them sits inside the issuer-lb module and that the module is gated on
# the profile. `loadbalancer`: the five OIDC paths, plus /jwks.json, /xaa/token and
# /xaa/callback, must all appear in the module's path_matcher — a missing path is an
# issuer that answers 404 on a route relying parties are required to reach.
#
# grep -F is used for the HCL fragments: they contain parentheses and brackets, which an
# extended regular expression would read as grouping and character classes and then match
# text that is not in the file (which is how this check silently passed nothing before).
set -euo pipefail

variables=infra/envs/demo/variables-issuer.tf
endpoints=infra/envs/demo/locals-endpoints.tf
profile=infra/envs/demo/issuer-profile.tf
module_main=infra/modules/issuer-lb/main.tf
reservation=infra/envs/shared/lb-reservation.tf

grep -qF 'contains(["direct", "loadbalancer"], var.issuer_profile)' "$variables" || {
  echo 'issuer-profile: validation is missing' >&2
  exit 1
}
grep -qF 'default = "direct"' "$variables" || {
  echo 'issuer-profile: direct must be the default profile' >&2
  exit 1
}
grep -qF 'var.issuer_profile == "direct"' "$endpoints" || {
  echo 'issuer-profile: endpoint switch is missing' >&2
  exit 1
}
grep -qF 'var.enable_lb_reservation ? 1 : 0' "$reservation" || {
  echo 'issuer-profile: LB reservation is not opt-in' >&2
  exit 1
}

# direct: the only instantiation of the LB is gated on the profile ...
grep -qF 'count           = var.issuer_profile == "loadbalancer" ? 1 : 0' "$profile" || {
  echo 'issuer-profile: the load balancer must be gated on issuer_profile' >&2
  exit 1
}
# ... and no other file in the demo state declares a google_compute_ resource.
stray=$(find infra/envs/demo -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -ln 'resource "google_compute_' || true)
[[ -z "$stray" ]] || {
  echo "issuer-profile: google_compute_ resources belong in the issuer-lb module, found in: $stray" >&2
  exit 1
}

# loadbalancer: every routed path is present in the module's path_matcher.
status=0
for path in '/authorize' '/token' '/userinfo' '/logout' '/.well-known/openid-configuration' '/jwks.json' '/xaa/token' '/xaa/callback'; do
  grep -qF "\"$path\"" "$module_main" || {
    printf 'issuer-profile / missing-path / %s\n' "$path" >&2
    status=1
  }
done
grep -qF 'path_matcher {' "$module_main" || { echo 'issuer-profile: path_matcher is missing' >&2; status=1; }
exit "$status"
