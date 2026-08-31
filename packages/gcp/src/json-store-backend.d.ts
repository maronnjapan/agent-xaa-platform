/**
 * Structural copy of the contract the generated OIDC provider's store.ts declares.
 * It is re-declared here rather than imported so packages/gcp never depends on a
 * generated app (DEC-APP-04). Keep the signatures byte-compatible with
 * `apps/<app>/src/oidc/store.ts`.
 */
export interface JsonStoreEntry<T> {
  key: string;
  value: T;
}

export interface JsonStoreBackend {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>>;
}
