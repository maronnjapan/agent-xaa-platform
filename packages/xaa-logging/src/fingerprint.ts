import { createHash } from 'node:crypto';

export function tokenFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
