import { sha256 } from '@xaa/crypto';

export async function workDefinitionHash(value: unknown): Promise<string> {
  const bytes = await sha256(JSON.stringify(value));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
