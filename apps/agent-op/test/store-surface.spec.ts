import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createAgentOpStore } from '../src/store/index.js';
import { baseConfig } from './helpers.js';

const store = () => createAgentOpStore(
  createFirestoreDocumentStore(createFirestoreDouble(), 'agent-op'), baseConfig(), () => 'op-shared-1',
);

describe('Agent OP persistence surface', () => {
  it('exports exactly four repositories', () => {
    expect(Object.keys(store()).sort()).toEqual(['idpConnections', 'issuerProfiles', 'registrations', 'xaaConfigs']);
  });

  it('agents, xaa config and issuer profile repositories expose no write method', () => {
    const readOnly = [store().registrations, store().xaaConfigs, store().issuerProfiles];
    for (const repository of readOnly) {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repository));
      for (const forbidden of ['set', 'update', 'delete', 'create']) expect(methods).not.toContain(forbidden);
    }
  });

  it('the connection repository is the only one that writes', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store().idpConnections));
    expect(methods).toContain('create');
    expect(methods).toContain('update');
  });

  it('never exposes a raw Firestore handle', () => {
    for (const repository of Object.values(store())) {
      expect(repository).not.toHaveProperty('collection');
      expect(repository).not.toHaveProperty('runTransaction');
    }
  });

  it('names only the documented collections', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const names = new Set<string>();
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(full, 'utf8');
        // Only DocumentStore calls, which always name the collection first and are
        // reached through the `documents` / `store` handles.
        for (const match of source.matchAll(/\b(?:documents|store|tx|seed)\.(?:get|set|update|delete|create|queryEqual|queryRange|listAll|transaction)<?[^(]*\(\s*'([a-z_]+)'/g)) {
          names.add(match[1]!);
        }
      }
    };
    await walk(root);
    expect([...names].sort()).toEqual([
      'agents', 'bridge_consent_states', 'idp_connection_rotations',
      'idp_connections', 'provisioning_transactions',
    ]);
  });

  it('keeps AgentRegistration and XaaStaticConfiguration as distinct types', async () => {
    const types = await readFile(new URL('../src/store/types.ts', import.meta.url).pathname, 'utf8');
    expect(types).toContain("readonly __kind?: 'agent-registration'");
    expect(types).toContain("readonly __kind?: 'xaa-static-configuration'");
  });
});
