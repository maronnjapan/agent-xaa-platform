import type { ToolDefinition } from '../../manifest/load.js';
import { redeemIdJag, type Redeemer } from './redeem-id-jag.js';
import { redeemViaBridge } from './redeem-via-bridge.js';

/**
 * One tool, one path, decided before anything is attempted.
 *
 * RULE-21 and REQ-05-089 forbid falling back from Native XAA to the Bridge. The
 * enforcement is structural rather than a rule to remember: the choice is a pure
 * function of the manifest's `authorization.type`, made once, and no error handler
 * anywhere calls the other redeemer. A Resource AS returning 500 produces
 * `resource_as_error`, not a second attempt through a different trust path — the
 * whole point of the native path is that the resource's own AS decides.
 */
export function selectRedeemer(tool: ToolDefinition): Redeemer {
  return tool.authorization.type === 'native_xaa' ? redeemIdJag : redeemViaBridge;
}
