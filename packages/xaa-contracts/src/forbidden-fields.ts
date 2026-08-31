export const AUTHORIZATION_INPUT_FIELDS = ['capabilities', 'effective_capabilities', 'scopes', 'resources', 'isolation_level', 'tools'] as const;

export function findAuthorizationInputFields(value: Record<string, unknown>): string[] {
  return AUTHORIZATION_INPUT_FIELDS.filter((field) => Object.hasOwn(value, field));
}
