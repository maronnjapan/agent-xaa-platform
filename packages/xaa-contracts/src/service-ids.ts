export const SERVICE_IDS = [
  'human-idp',
  'shared-agent-op',
  'agent-op-callback',
  'automation-app',
  'provisioner',
  'authorization',
  'lifecycle',
  'resource-docs-as',
  'resource-docs-api',
  'resource-finance-as',
  'resource-finance-api',
  'stub-saas-op',
  'google-bridge',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];
