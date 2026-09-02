export * from './firestore-client.js';
export * from './firestore-json-store.js';
export * from './firestore-jti-store.js';
export * from './firestore-guard.js';
export * from './document-store.js';
export * from './identity-token.js';
export * from './testing/firestore-double.js';
export type * from './json-store-backend.js';
// T-PKG-25: `@google-cloud/firestore` is imported here and nowhere else in the
// repository, so anything that needs to name the client type takes it from @xaa/gcp.
export type { Firestore } from '@google-cloud/firestore';
