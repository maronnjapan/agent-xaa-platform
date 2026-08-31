import { compile } from '@xaa/contracts';

export const consentRequiredSchema = {
  $id: 'consent-required',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'transaction_id', 'consent_url'],
  properties: {
    status: { enum: ['IDP_CONSENT_REQUIRED', 'CONSENT_REQUIRED'] },
    transaction_id: { type: 'string' },
    consent_url: { type: 'string', format: 'uri' },
    connector_id: { type: 'string' },
  },
} as const;

export interface ConsentRequired {
  status: 'IDP_CONSENT_REQUIRED' | 'CONSENT_REQUIRED';
  transaction_id: string;
  consent_url: string;
  connector_id?: string;
}

const assertConsent: (value: unknown) => asserts value is ConsentRequired = compile<ConsentRequired>(consentRequiredSchema);

export class InvalidConsentUrl extends Error {
  constructor() { super('invalid_consent_url'); }
}

/**
 * RULE-37. The Provisioner is internal-only, so a browser can never be sent to it.
 * The consent URL always points at Human IdP or the Bridge's public callback face,
 * and the check below fails loudly rather than handing the browser an address it
 * cannot reach.
 *
 * The status is 200 with a `status` field, not a 3xx: the caller is Automation App
 * making an API call, and it is the one that will redirect the browser.
 */
export function buildConsentResponse(input: {
  status: 'IDP_CONSENT_REQUIRED' | 'CONSENT_REQUIRED';
  transactionId: string;
  consentUrl: string;
  connectorId?: string;
  provisionerHost: string;
}): ConsentRequired {
  const response: ConsentRequired = {
    status: input.status,
    transaction_id: input.transactionId,
    consent_url: input.consentUrl,
    ...(input.status === 'CONSENT_REQUIRED' && input.connectorId ? { connector_id: input.connectorId } : {}),
  };
  if (new URL(response.consent_url).host === input.provisionerHost) throw new InvalidConsentUrl();
  assertConsent(response);
  return response;
}
