import type { CleanupContext } from '../clients/types.js';
import type { CleanupStepId } from './result.js';
import { runtimeCancel } from './steps/runtime-cancel.js';
import { issuanceDisable } from './steps/issuance-disable.js';
import { idpConnectionRevoke } from './steps/idp-connection-revoke.js';
import { bridgeBindingDisable } from './steps/bridge-binding-disable.js';
import { credentialRevoke } from './steps/credential-revoke.js';
import { clientCredentialRevoke } from './steps/client-credential-revoke.js';
import { runtimeStateDelete } from './steps/runtime-state-delete.js';
import { dedicatedDestroy, dedicatedSaDelete } from './steps/dedicated-destroy.js';
import { registrationDelete } from './steps/registration-delete.js';
import { auditPersist } from './steps/audit-persist.js';

export interface CleanupStep {
  id: CleanupStepId;
  run(context: CleanupContext & { startedAt: string; stepResults: unknown[] }): Promise<'succeeded' | 'skipped'>;
}

/**
 * The eleven steps, in the order docs 07 §6 sets out.
 *
 * The order is a property of the design, not a parameter: stopping the process comes
 * before stopping issuance, which comes before revoking what was already issued, which
 * comes before deleting the record of it. A caller that could reorder them could
 * delete the registration first and lose the information the later steps need.
 */
export const CLEANUP_STEPS: readonly CleanupStep[] = [
  { id: 'runtime_cancel', run: runtimeCancel },
  { id: 'issuance_disable', run: issuanceDisable },
  { id: 'idp_connection_revoke', run: idpConnectionRevoke },
  { id: 'bridge_binding_disable', run: bridgeBindingDisable },
  { id: 'credential_revoke', run: credentialRevoke },
  { id: 'client_credential_revoke', run: clientCredentialRevoke },
  { id: 'runtime_state_delete', run: runtimeStateDelete },
  { id: 'dedicated_destroy', run: dedicatedDestroy },
  { id: 'dedicated_sa_delete', run: dedicatedSaDelete },
  { id: 'registration_delete', run: registrationDelete },
  { id: 'audit_persist', run: auditPersist },
];
