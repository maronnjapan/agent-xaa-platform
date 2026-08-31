export const xaaStaticConfigSchema = {
  $id: 'xaa-static-config',
  type: 'object',
  additionalProperties: false,
  required: ['allowed_audiences', 'resources', 'scopes', 'trusted_resource_as', 'expires_at'],
  properties: {
    allowed_audiences: { type: 'array', items: { type: 'string', format: 'uri' }, uniqueItems: true },
    resources: { type: 'array', items: { type: 'string', format: 'uri' }, uniqueItems: true },
    scopes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    trusted_resource_as: { type: 'array', items: { type: 'string', format: 'uri' }, uniqueItems: true },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;
