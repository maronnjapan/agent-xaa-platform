import type { PlatformEndpoints } from '@xaa/contracts';

const PLACEHOLDERS: Record<string, keyof PlatformEndpoints> = {
  'issuer:docs': 'resource_docs_as_issuer',
  'resource:docs': 'resource_docs_api_url',
  'issuer:finance': 'resource_finance_as_issuer',
  'resource:finance': 'resource_finance_api_url',
  'bridge:internal': 'bridge_internal_url',
  'issuer:stub_saas': 'stub_saas_op_issuer',
};

export function resolveSeedPlaceholders(source: string, endpoints: PlatformEndpoints): string {
  const result = source.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    return key ? String(endpoints[key]) : whole;
  });
  const unresolved = [...result.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  if (unresolved.length) throw new Error(`unresolved seed placeholders: ${unresolved.join(', ')}`);
  return result;
}
