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

# The scan above reads a window of lines, which depends on where `role` sits relative to
# `member`. The forbidden roles get a second, order-independent pass over whole resource
# blocks: a binding reaches the Runtime if the block names the runtime service account
# directly, or iterates a `local` whose definition contains it (which is how every IAM
# binding in infra/envs/demo is written).
runtime_locals=$(awk '
  function flush() {
    if (name != "" && buf ~ /agent_runtime|sa-agent-runtime/) print name
    name = ""; buf = ""
  }
  /^locals[[:space:]]*\{/ { inlocals = 1; next }
  inlocals && /^\}/ { flush(); inlocals = 0; next }
  inlocals && /^[[:space:]][[:space:]][A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
    flush(); name = $1; buf = $0; next
  }
  inlocals { buf = buf "\n" $0 }
  END { flush() }
' $(find infra -name '*.tf' -not -path '*/.terraform/*') | sort -u)

# A local that only references another runtime-bearing local counts too (invoker_edges
# is built from invoker_edge_pairs, artifact_readers from the service account map).
for _ in 1 2 3; do
  more=$(awk -v known="$runtime_locals" '
    BEGIN { split(known, list, "\n"); for (i in list) if (list[i] != "") seen[list[i]] = 1 }
    function flush() {
      if (name != "") for (n in seen) if (buf ~ ("local\\." n "[^A-Za-z0-9_]")) print name
      name = ""; buf = ""
    }
    /^locals[[:space:]]*\{/ { inlocals = 1; next }
    inlocals && /^\}/ { flush(); inlocals = 0; next }
    inlocals && /^[[:space:]][[:space:]][A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      flush(); name = $1; buf = $0; next
    }
    inlocals { buf = buf "\n" $0 }
    END { flush() }
  ' $(find infra -name '*.tf' -not -path '*/.terraform/*') | sort -u)
  runtime_locals=$(printf '%s\n%s\n' "$runtime_locals" "$more" | sed '/^$/d' | sort -u)
done

block_hits=$(awk -v forbidden="$forbidden" -v locals="$runtime_locals" '
  BEGIN {
    split(forbidden, bad, " ")
    split(locals, list, "\n"); for (i in list) if (list[i] != "") known[list[i]] = 1
  }
  function check() {
    if (block == "") return
    reaches = (block ~ /agent_runtime|sa-agent-runtime/)
    if (!reaches) for (n in known) if (block ~ ("local\\." n "[^A-Za-z0-9_]")) reaches = 1
    if (!reaches) { block = ""; return }
    for (i in bad) if (index(block, bad[i]) > 0) print header " / " bad[i]
    block = ""
  }
  /^resource[[:space:]]+"/ { check(); header = FILENAME ": " $0; block = $0; next }
  block != "" && /^\}/ { block = block "\n" $0; check(); next }
  block != "" { block = block "\n" $0 }
  END { check() }
' $(find infra -name '*.tf' -not -path '*/.terraform/*'))

if [ -n "$block_hits" ]; then
  echo "$block_hits" | while read -r hit; do echo "sa-agent-runtime must not hold $hit" >&2; done
  status=1
fi

[ "$status" -eq 0 ] && echo "ok: sa-agent-runtime roles are within the allow list"
exit "$status"
