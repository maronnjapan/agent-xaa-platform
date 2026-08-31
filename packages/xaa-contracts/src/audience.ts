export function audienceIncludes(aud: unknown, self: string): boolean {
  if (typeof aud === 'string') return aud === self;
  return Array.isArray(aud) && aud.some((value) => value === self);
}
