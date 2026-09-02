import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ManifestIntegrityError, deepFreeze, loadToolManifest, manifestSha256 } from '../src/manifest/load.js';
import { buildToolDeclarations } from '../src/reasoning/tool-declarations.js';
import { buildAllowedHosts, assertHostAllowed, HostNotAllowed, PLATFORM_HOSTS } from '../src/http/allowed-hosts.js';
import { createRuntimeHttpClient } from '../src/http/http-client.js';
import type { InvokerIdToken } from '../src/http/internal-invoker-token.js';
import { AGENT_OP, DOCS_API, DOCS_AS, docsManifest } from './helpers.js';

function envFor(manifest: unknown, sha?: string): { TOOL_MANIFEST: string; TOOL_MANIFEST_SHA256: string } {
  const raw = JSON.stringify(manifest);
  return { TOOL_MANIFEST: raw, TOOL_MANIFEST_SHA256: sha ?? manifestSha256(raw) };
}

describe('loading the tool manifest', () => {
  it('rejects a sha256 mismatch', () => {
    expect(() => loadToolManifest(envFor(docsManifest(), 'deadbeef'))).toThrow(ManifestIntegrityError);
  });

  it('rejects a tool without response_schema', () => {
    const manifest = docsManifest();
    const broken = {
      ...manifest,
      tools: manifest.tools.map((tool) => Object.fromEntries(
        Object.entries(tool).filter(([key]) => key !== 'response_schema'),
      )),
    };
    expect(() => loadToolManifest(envFor(broken))).toThrow();
  });

  it('rejects a tool id outside the catalogue', () => {
    const manifest = docsManifest();
    const broken = { ...manifest, tools: [{ ...manifest.tools[0]!, tool_id: 'internal.document.destroy' }] };
    expect(() => loadToolManifest(envFor(broken))).toThrow();
  });

  it('rejects an allowlist entry the projection cannot read', () => {
    const manifest = docsManifest();
    const broken = {
      ...manifest,
      tools: [{ ...manifest.tools[0]!, response_schema: { type: 'array', allowlist: ['$.items[*].title'] } }],
    };
    // The manifest schema's pattern is the one place this rule lives, so a path the
    // projection cannot parse never reaches the Runtime at all.
    expect(() => loadToolManifest(envFor(broken))).toThrow();
  });

  it('manifest is deeply frozen', () => {
    const manifest = loadToolManifest(envFor(docsManifest()));
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tools)).toBe(true);
    expect(Object.isFrozen(manifest.tools[0]!.authorization)).toBe(true);
    expect(() => { (manifest.tools as unknown as unknown[]).push({}); }).toThrow();
  });

  it('carries no bridged tool when the bridge is off', () => {
    // The default seed builds no xaa_bridge tool: enable_google_bridge=false means
    // the Provisioner never resolves the bridged connector into a manifest.
    const manifest = loadToolManifest(envFor(docsManifest()));
    expect(manifest.tools.filter((tool) => tool.authorization.type === 'xaa_bridge')).toHaveLength(0);
    expect(manifest.tools.every((tool) => tool.token_provider === null)).toBe(true);
  });

  it('freezes nested values without looping on a cycle', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(() => deepFreeze(value)).not.toThrow();
  });
});

describe('the tool declarations offered to the model', () => {
  it('declaration set equals allowed tools', () => {
    const manifest = docsManifest();
    expect(buildToolDeclarations(manifest).map((declaration) => declaration.name))
      .toEqual(manifest.tools.map((tool) => tool.tool_id));
  });

  it('offers no generic transport', () => {
    const names = buildToolDeclarations(docsManifest()).map((declaration) => declaration.name);
    for (const forbidden of ['http_request', 'fetch', 'browse', 'shell', 'code_exec', 'eval']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('the reachable host set', () => {
  it('is exactly the Agent OP, the manifest destinations and the platform endpoints', () => {
    const hosts = buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP }, docsManifest());
    expect([...hosts].sort()).toEqual([
      ...PLATFORM_HOSTS, new URL(AGENT_OP).host, new URL(DOCS_AS).host, new URL(DOCS_API).host,
    ].sort());
  });

  it('rejects a request to a host outside the list', () => {
    const hosts = buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP }, docsManifest());
    expect(() => assertHostAllowed(hosts, 'https://evil.example.test/documents')).toThrow(HostNotAllowed);
    expect(() => assertHostAllowed(hosts, `${DOCS_API}/documents`)).not.toThrow();
  });

  it('names neither the Human IdP nor the Provisioner', () => {
    const hosts = buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP }, docsManifest());
    expect([...hosts].some((host) => host.includes('human-idp') || host.includes('provisioner'))).toBe(false);
  });

  it('allowed host set is frozen', () => {
    const hosts = buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP }, docsManifest());
    expect(Object.isFrozen(hosts)).toBe(true);
    expect(() => (hosts as Set<string>).add('evil.example.test')).toThrow();
  });

  /**
   * REQ-04-015: an audience or a scope is a value the provisioning decided, so nothing
   * in the Runtime offers a door to pass a different one in. The check reads the
   * exported signatures rather than the call sites, because a call site can be changed
   * and a signature is the thing that would have to be widened first.
   */
  it('no exported function takes audience or scope', async () => {
    // The reader itself, checked on a signature that should be caught and one that
    // should not, so an empty result below means "none", not "read nothing".
    const forbidden = ['audience', 'resource', 'scope'];
    const namesOf = (source: string): string[] =>
      exportedParameterLists(source).flatMap((entry) => topLevelParameterNames(entry.list));
    expect(namesOf('export function widen(audience: string, key: DpopKey): void {}'))
      .toEqual(['audience', 'key']);
    expect(namesOf('export function narrow(input: { audience: string; scope: string }): void {}'))
      .toEqual(['input']);

    const offenders: string[] = [];
    let scanned = 0;
    for (const file of await sourceFiles()) {
      for (const parameters of exportedParameterLists(file.text)) {
        scanned += 1;
        for (const name of topLevelParameterNames(parameters.list)) {
          if (forbidden.includes(name)) {
            offenders.push(`${file.path.split('/src/')[1]}: ${parameters.name}(${name})`);
          }
        }
      }
    }
    expect(scanned).toBeGreaterThan(15);
    expect(offenders).toEqual([]);

    // The values do travel — inside the manifest's own `authorization` object, which
    // is what the token store key and the exchange body are built from.
    const [tool] = docsManifest().tools;
    expect(Object.keys(tool!.authorization).sort()).toEqual(['audience', 'resource', 'scope', 'type']);
  });
});

async function sourceFiles(): Promise<Array<{ path: string; text: string }>> {
  const root = new URL('../src', import.meta.url).pathname;
  const found: Array<{ path: string; text: string }> = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.name.endsWith('.ts')) found.push({ path: full, text: await readFile(full, 'utf8') });
    }
  };
  await walk(root);
  return found;
}

/** Every `export function name(...)`, with the text between its outermost parentheses. */
function exportedParameterLists(text: string): Array<{ name: string; list: string }> {
  const found: Array<{ name: string; list: string }> = [];
  const declaration = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    let depth = 1;
    let index = declaration.lastIndex;
    while (index < text.length && depth > 0) {
      if ('([{'.includes(text[index]!)) depth += 1;
      if (')]}'.includes(text[index]!)) depth -= 1;
      index += 1;
    }
    found.push({ name: match[1]!, list: text.slice(declaration.lastIndex, index - 1) });
  }
  return found;
}

/** Parameter names only: a nested type literal's members are not parameters. */
function topLevelParameterNames(list: string): string[] {
  const flattened = list.replace(/\{[^{}]*\}/g, '{}');
  return flattened.split(',')
    .map((part) => part.trim().split(':')[0]!.trim().replace(/[?]$/, ''))
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
}

/**
 * Cloud Run refuses a call to an INTERNAL_ONLY service before the app sees it, so the
 * Execution's own invoker token has to ride along to the Agent OP and the Bridge — and
 * nowhere else, because a platform identity arriving at a resource would be an identity
 * that resource could act on.
 */
describe('the invoker token on internal calls', () => {
  const AGENT_OP_ORIGIN = new URL(AGENT_OP).origin;

  function clientFor(sent: Array<{ url: string; headers: Record<string, string> }>) {
    return createRuntimeHttpClient({
      allowedHosts: buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP }, docsManifest()),
      internalOrigins: new Set([AGENT_OP_ORIGIN]),
      invokerToken: async (audience) => `id-token-for-${audience}` as InvokerIdToken,
      fetch: async (url, init) => {
        sent.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
        return new Response('{}', { status: 200 });
      },
    });
  }

  it('carries the token to the Agent OP beside the request\'s own Authorization', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    await clientFor(sent).send(`${AGENT_OP}/xaa/token`, {
      method: 'POST', headers: { Authorization: 'DPoP agent-token' },
    });
    expect(sent[0]!.headers['X-Serverless-Authorization']).toBe(`Bearer id-token-for-${AGENT_OP_ORIGIN}`);
    expect(sent[0]!.headers.Authorization).toBe('DPoP agent-token');
  });

  it('leaves a resource call untouched', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    await clientFor(sent).send(`${DOCS_API}/documents`, { method: 'GET' });
    expect(sent[0]!.headers['X-Serverless-Authorization']).toBeUndefined();
  });
});
