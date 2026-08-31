/**
 * REQ-01-016 / DEC-ID-18. Under one issuer and one shared JWK Set, an ID Token, an
 * Access Token and an ID-JAG all carry the same `iss` and are all verifiable with the
 * same keys. Only `typ` tells them apart, so there is no general-purpose verifier to
 * call: these three are the whole public surface, each with its `iss` and `typ`
 * pinned inside.
 *
 * The implementation lives in packages/xaa-crypto; this module is the contract-level
 * name for it, so an application never reaches for the internal helper by accident.
 * `verifyJwtInternal` is deliberately absent from this re-export.
 */
export {
  verifyHumanAccessToken,
  verifyIdJag,
  verifyGoogleServiceIdentity,
} from '@xaa/crypto';

export type { JwksCache } from '@xaa/crypto';
