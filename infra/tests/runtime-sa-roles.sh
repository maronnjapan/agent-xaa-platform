#!/usr/bin/env bash
# T-RUN-03 / REQ-05-091. The Runtime's service account may read Firestore, invoke the
# services it is allowed to reach, call Vertex, publish activity and write logs. It may
# not sign with KMS and may not read Secret Manager: an agent that could do either
# would be able to mint its own credentials rather than being handed narrow ones.
set -euo pipefail
cd "$(dirname "$0")/../.."

allowed='roles/datastore.user roles/run.invoker roles/aiplatform.user roles/pubsub.publisher roles/logging.logWriter'
forbidden='roles/cloudkms.signerVerifier roles/cloudkms.cryptoKeyEncrypterDecrypter roles/secretmanager.secretAccessor'
status=0

runtime_roles=$(grep -rn 'sa-agent-runtime\|agent_runtime' infra --include='*.tf' -B 6 \
  | grep -oE 'roles/[a-zA-Z.]+' | sort -u || true)

for role in $runtime_roles; do
  case " $allowed " in
    *" $role "*) ;;
    *) echo "sa-agent-runtime must not hold $role" >&2; status=1 ;;
  esac
done

for role in $forbidden; do
  case " $runtime_roles " in
    *" $role "*) echo "sa-agent-runtime must not hold $role" >&2; status=1 ;;
  esac
done

[ "$status" -eq 0 ] && echo "ok: sa-agent-runtime roles are within the allow list"
exit "$status"
