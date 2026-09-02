#!/usr/bin/env bash
# T-OP-03 / REQ-05-036. sa-shared-agent-op holds exactly the grants Agent OP needs to
# issue a grant and nothing it could decide with: sign with one KMS key, decrypt
# refresh tokens with another, read Firestore, write its own keys/op-shared-* object,
# publish activity, and read the one client secret /xaa/subject-token spends
# (DEC-ID-19). No Vertex, no admin role, no Secret Manager beyond that secret.
#
# Static, on the Terraform sources: `terraform plan -json` needs a project, and this
# has to fail in review rather than after an apply.
set -uo pipefail
cd "$(dirname "$0")/../.."

demo=infra/envs/demo
status=0
fail() { echo "agent-op-roles: $1" >&2; status=1; }

for file in iam-project.tf iam-kms.tf iam-jwks.tf iam-secrets.tf pubsub-activity.tf; do
  [[ -f "$demo/$file" ]] || fail "missing $demo/$file"
done
[[ $status -eq 0 ]] || exit 1

# The five list-driven grants, each read out of the list that drives it.
if ! sed -n '/datastore_users = toset/,/])/p' "$demo/iam-project.tf" | grep -q '"shared_agent_op"'; then
  fail 'sa-shared-agent-op is missing roles/datastore.user'
fi
if ! sed -n '/activity_publishers = setunion/,/])/p' "$demo/pubsub-activity.tf" | grep -q '"shared_agent_op"'; then
  fail 'sa-shared-agent-op is missing roles/pubsub.publisher on agent-activity-stream'
fi
if ! grep -q 'shared_agent_op *= *"op-shared-"' "$demo/iam-jwks.tf"; then
  fail 'sa-shared-agent-op may only write keys/op-shared-* in the JWKS bucket'
fi
if ! grep -q 'roles/cloudkms.signerVerifier' "$demo/iam-kms.tf"; then
  fail 'sa-shared-agent-op is missing roles/cloudkms.signerVerifier on the ID-JAG key'
fi
if ! grep -q 'human_idp_client_secret_ids.agent_platform' "$demo/iam-secrets.tf"; then
  fail 'the only readable secret must be the agent-platform client secret'
fi

# And the grants it must never hold. roles/aiplatform.user is the one that would let
# Agent OP form an opinion; the admin roles would let it grant itself anything.
if sed -n '/vertex_users/p' "$demo/iam-project.tf" | grep -q 'shared_agent_op'; then
  fail 'sa-shared-agent-op must not hold roles/aiplatform.user'
fi
forbidden='roles/aiplatform.user roles/run.admin roles/cloudkms.admin roles/iam.serviceAccountAdmin roles/owner roles/editor roles/resourcemanager.projectIamAdmin'
while IFS= read -r line; do
  for role in $forbidden; do
    case "$line" in *"$role"*) fail "sa-shared-agent-op must not hold $role" ;; esac
  done
done < <(grep -rn 'service_accounts\["shared_agent_op"\]' "$demo"/*.tf -B 8 | grep -oE 'roles/[a-zA-Z.]+')

[[ $status -eq 0 ]] && echo 'ok: sa-shared-agent-op holds exactly the allowed roles'
exit "$status"
