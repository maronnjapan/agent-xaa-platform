#!/usr/bin/env bash
# T-APP-14 / RULE-27 / RULE-41. Stopping an agent means cancelling a Job, scheduling key
# destruction and writing a terminal status — all of which the Lifecycle Manager owns.
# The Automation App asks it to; if `sa-automation-app` could do any of it directly, two
# services would be deciding when an agent's credentials stop working.
set -euo pipefail
cd "$(dirname "$0")/../.."

forbidden='roles/run.admin roles/run.developer roles/cloudkms.admin roles/cloudkms.signerVerifier roles/cloudkms.cryptoKeyEncrypterDecrypter'
status=0

roles=$(grep -rn 'automation_app' infra --include='*.tf' -B 6 | grep -oE 'roles/[a-zA-Z.]+' | sort -u || true)
for role in $forbidden; do
  case " $roles " in
    *" $role "*) echo "sa-automation-app must not hold $role" >&2; status=1 ;;
  esac
done

[ "$status" -eq 0 ] && echo "ok: sa-automation-app cannot destroy an agent itself"
exit "$status"
