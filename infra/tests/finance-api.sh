#!/usr/bin/env bash
# Does the Finance path work on this project?
#
# The other checks in this directory measure IAM: who may call what. That is necessary
# and it is not the question a person asks after a deploy, which is whether the Agent
# they are about to create can read a payment and approve one. Every layer between those
# two answers is owned by a different file, and each of them fails silently:
#
#   - the Resource AS boots but bootstraps no signing key, so redemption 500s;
#   - the API boots without its guard, so it answers 200 to a caller with no token;
#   - the seed Job never ran, so the catalogue has no finance Tool and the Provisioner
#     resolves `finance.payment.approve` to nothing;
#   - the login the guide names holds no Human Permission, so every decision intersects
#     with an empty set and the Agent is granted nothing;
#   - the seeded payments all sit above the ceiling the risk policy attaches, so the
#     Agent is refused on every row it can see.
#
# All five read on screen as "the Agent was created and then did nothing". This asks each
# of them directly, so the answer names the layer.
#
# packages/xaa-contracts/test/finance-chain.spec.ts asks the same questions of the files
# in the repository, and runs on every change. This one asks the project, and so can only
# run after an apply and a seed.
set -uo pipefail

command -v gcloud >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null || {
  echo 'finance-api: gcloud, jq, and curl are required' >&2; exit 2; }
demo_dir=${DEMO_TF_DIR:-infra/envs/demo}
read -r -a tf_command <<<"${TF:-terraform}"
project_id=${PROJECT_ID:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw project_id 2>/dev/null)}
region=${REGION:-$("${tf_command[@]}" -chdir="$demo_dir" output -raw region 2>/dev/null)}
[[ -n "$project_id" && -n "$region" ]] || { echo 'finance-api: PROJECT_ID and REGION are required' >&2; exit 2; }
database=${FIRESTORE_DATABASE:-xaa-db}
login_user=${DEMO_LOGIN_USER:-testuser}

status=0
fail() { printf 'finance-api / %s\n' "$*" >&2; status=1; }
ok() { printf 'finance-api / ok / %s\n' "$*"; }

urls=$("${tf_command[@]}" -chdir="$demo_dir" output -json service_urls 2>/dev/null) || {
  echo 'finance-api: demo Terraform output is unavailable' >&2; exit 2; }
as_url=$(jq -r '."resource-finance-as" // empty' <<<"$urls")
api_url=$(jq -r '."resource-finance-api" // empty' <<<"$urls")
[[ -n "$as_url" && -n "$api_url" ]] || { echo 'finance-api: the finance services are not in the Terraform output' >&2; exit 2; }

# Both finance services are `roles/run.invoker`-gated with no anonymous grant, so the
# calls below speak as the one identity that is allowed to make them at run time. Cloud
# Run reads `X-Serverless-Authorization` for IAM and leaves `Authorization` untouched,
# which is exactly how the Agent Runtime presents an Access Token behind Cloud Run
# (apps/agent-runtime/src/http/internal-invoker-token.ts).
runtime_sa="sa-agent-runtime@${project_id}.iam.gserviceaccount.com"
invoker_token() {
  gcloud auth print-identity-token --project="$project_id" \
    --impersonate-service-account="$runtime_sa" --audiences="$1" 2>/dev/null
}
as_token=$(invoker_token "$as_url") || true
api_token=$(invoker_token "$api_url") || true
if [[ -z "$as_token" || -z "$api_token" ]]; then
  echo "finance-api: $runtime_sa cannot be impersonated; roles/iam.serviceAccountTokenCreator on it is required" >&2
  echo 'finance-api: `make verify` adds it for the length of the run' >&2
  exit 2
fi

# --- the Authorization Server in front of the payments ---------------------------------

discovery=$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "X-Serverless-Authorization: Bearer $as_token" "$as_url/.well-known/openid-configuration" || true)
if ! jq -e . >/dev/null 2>&1 <<<"$discovery"; then
  fail "the Resource AS returned no discovery document at $as_url"
else
  # The one grant profile the whole chain runs on: without it advertised, this is not
  # serving as a Resource AS whatever else it answers.
  if [[ $(jq -r '.authorization_grant_profiles_supported // [] | index("urn:ietf:params:oauth:grant-profile:id-jag") // "absent"' <<<"$discovery") == absent ]]; then
    fail 'the Resource AS does not advertise the ID-JAG grant profile'
  else
    ok 'the Resource AS advertises the ID-JAG grant profile'
  fi
  [[ $(jq -r '.issuer // ""' <<<"$discovery") == "$as_url" ]] ||
    fail "the Resource AS issuer is $(jq -r '.issuer // "(absent)"' <<<"$discovery"), not its own URL $as_url"
fi

# The signing key is bootstrapped by the service on first use and wrapped with KMS
# (DEV-10). A service that cannot reach its bucket or its key starts and serves an empty
# key set, and the failure only shows up at the first redemption.
jwks=$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "X-Serverless-Authorization: Bearer $as_token" "$as_url/.well-known/jwks.json" || true)
kid=$(jq -r '.keys // [] | map(select(.kid // "" | startswith("fin-as-"))) | .[0].kid // ""' <<<"$jwks" 2>/dev/null)
if [[ -z "$kid" ]]; then
  fail 'the Resource AS publishes no signing key with the fin-as- prefix'
else
  ok "the Resource AS signs as $kid"
fi

# --- the API that holds the payments ---------------------------------------------------

# Authorized at the Cloud Run door and carrying no Access Token at all. 401 is the
# resource guard doing its job; 200 would mean the guard is not mounted, and 5xx that the
# service cannot reach Firestore.
unauthenticated=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "X-Serverless-Authorization: Bearer $api_token" "$api_url/payments" || true)
case "$unauthenticated" in
  401) ok 'the Finance API refuses a call that carries no Access Token' ;;
  200) fail 'the Finance API answered 200 to a call with no Access Token; the resource guard is not in front of /payments' ;;
  *) fail "the Finance API answered $unauthenticated to a call with no Access Token, where 401 was expected" ;;
esac

livez=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "X-Serverless-Authorization: Bearer $api_token" "$api_url/livez" || true)
[[ "$livez" == 200 ]] && ok 'the Finance API is serving' || fail "the Finance API answered $livez at /livez"

# --- what the seed Job was supposed to put in Firestore --------------------------------

access_token=$(gcloud auth print-access-token --project="$project_id" 2>/dev/null) || true
firestore="https://firestore.googleapis.com/v1/projects/${project_id}/databases/${database}/documents"
# `documents.list` rather than a structured query: the runner may hold read access
# without the index a query would need, and every collection read here is small.
collection() {
  curl -sS --connect-timeout 10 --max-time 60 \
    -H "Authorization: Bearer $access_token" "${firestore}/$1?pageSize=300" || true
}

if [[ -z "$access_token" ]]; then
  fail 'no access token for the Firestore read; the seeded rows were not checked'
else
  tools=$(collection catalog_tools)
  seeded_tools=$(jq -r '[.documents // [] | .[].name | split("/") | last | select(startswith("internal.finance."))] | sort | join(" ")' <<<"$tools" 2>/dev/null)
  expected_tools='internal.finance.payment.approve internal.finance.payment.get internal.finance.payment.list'
  [[ "$seeded_tools" == "$expected_tools" ]] ||
    fail "catalog_tools holds [${seeded_tools:-none}] for finance, not [$expected_tools]; run \`make seed\`"

  connectors=$(collection catalog_connectors)
  jq -e '[.documents // [] | .[].name | split("/") | last] | index("internal-finance-api")' >/dev/null 2>&1 <<<"$connectors" ||
    fail 'catalog_connectors has no internal-finance-api row; the Provisioner cannot resolve a finance capability'

  # The characteristic that forces FULL_ISOLATION. It is the taxonomy's to state, so a
  # row that lost it downgrades every finance Agent without anything failing.
  approve=$(curl -sS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $access_token" "${firestore}/capability_taxonomy/finance.payment.approve" || true)
  [[ $(jq -r '.fields.default_characteristics.mapValue.fields.financial_operation.booleanValue // "false"' <<<"$approve" 2>/dev/null) == true ]] ||
    fail 'capability_taxonomy/finance.payment.approve is missing financial_operation: true; the approval would not force full isolation'

  # RULE-11: without these two rows the login the guide names is granted nothing, and the
  # screen shows the platform refusing rather than data nobody seeded.
  for capability in finance.payment.read finance.payment.approve; do
    row=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $access_token" "${firestore}/human_permissions/${login_user}__${capability}" || true)
    [[ "$row" == 200 ]] ||
      fail "$login_user holds no $capability (human_permissions answered $row); \`pnpm perm:set $login_user $capability grant\`"
  done

  # The ceiling the Policy Engine attaches, read off the deployed rule rather than
  # assumed, and then the payments measured against it. A seed whose rows all sit above
  # it leaves an Agent refused on every payment it can see.
  rule=$(curl -sS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $access_token" "${firestore}/risk_policies/risk-001" || true)
  ceiling=$(jq -r '.fields.added_constraint.mapValue.fields.max_amount.integerValue // ""' <<<"$rule" 2>/dev/null)
  isolation=$(jq -r '.fields.min_isolation_level.stringValue // ""' <<<"$rule" 2>/dev/null)
  [[ "$isolation" == full_isolation ]] ||
    fail "risk_policies/risk-001 sets min_isolation_level=${isolation:-absent}, not full_isolation"
  payments=$(collection payments)
  pending=$(jq -r '[.documents // [] | .[] | select(.fields.status.stringValue == "pending_approval") | .fields.amount.integerValue | tonumber] | join(" ")' <<<"$payments" 2>/dev/null)
  if [[ -z "$pending" ]]; then
    fail 'no payment is waiting for approval; the seeded demo rows are missing or already approved'
  elif [[ -n "$ceiling" ]]; then
    approvable=0
    for amount in $pending; do ((amount <= ceiling)) && ((approvable++)); done
    if ((approvable == 0)); then
      fail "every payment waiting for approval is above the ${ceiling} ceiling risk-001 attaches; an Agent would be refused on all of them"
    else
      ok "$approvable of $(wc -w <<<"$pending") payments waiting for approval are within the ${ceiling} ceiling"
    fi
  fi
fi

((status == 0)) && echo 'finance-api: the Finance path answers, and the permissions behind it are seeded'
exit "$status"
