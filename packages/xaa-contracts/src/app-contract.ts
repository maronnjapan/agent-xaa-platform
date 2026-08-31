import type { Hono } from 'hono';
import type { Es256Signer, JtiStore } from '@xaa/crypto';
import type { HttpClient } from './http-client.js';

export interface AppDeps {
  httpClient: HttpClient;
  signer: Es256Signer;
  jtiStore: JtiStore;
  store: unknown;
  now: () => number;
  logger: { info(event: unknown): void; error(event: unknown): void };
}

export type CreateApp = (deps?: Partial<AppDeps>) => Hono;
