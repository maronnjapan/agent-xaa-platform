import { beforeAll, describe, expect, it } from 'vitest';
import { compile, SchemaValidationError } from '@xaa/contracts';
import {
  buildConsentResponse, consentRequiredSchema, InvalidConsentUrl, type ConsentRequired,
} from '../src/routes/consent-response.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, PROVISIONER_BASE, type TokenIssuer } from './helpers.js';

/**
 * RULE-37. The Provisioner is not on the Internet, so a browser can never be sent to
 * it. A consent that needs a person's attention has to end up somewhere the person's
 * browser can actually reach: Human IdP's `/authorize`, or the Bridge's public callback
 * face — never this service.
 *
 * The reply is a 200 with a `status` field rather than a redirect. The caller is the
 * Automation App making an API call, and it is the one that redirects the browser; a
 * 3xx here would be a redirect aimed at a machine.
 *
 * The shape is closed so the two forms cannot blur: an IdP consent has no connector to
 * name, and an external one always does.
 */
const assertConsent: (value: unknown) => asserts value is ConsentRequired =
  compile<ConsentRequired>(consentRequiredSchema);

let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

describe('the reply that pauses a provisioning', () => {
  it('validates both forms against the closed schema', () => {
    const idp = buildConsentResponse({
      status: 'IDP_CONSENT_REQUIRED', transactionId: 'txn_aaaaaaaaaaaaaaaaaaaaaa',
      consentUrl: 'https://human-idp.test/authorize?client_id=agent-platform',
      provisionerHost: 'provisioner.test',
    });
    expect(() => assertConsent(idp)).not.toThrow();
    expect(idp).not.toHaveProperty('connector_id');

    const external = buildConsentResponse({
      status: 'CONSENT_REQUIRED', transactionId: 'txn_aaaaaaaaaaaaaaaaaaaaaa',
      consentUrl: 'https://google-bridge.test/stub-saas-calendar/oauth/start',
      connectorId: 'stub-saas-calendar', provisionerHost: 'provisioner.test',
    });
    expect(() => assertConsent(external)).not.toThrow();
    expect(external.connector_id).toBe('stub-saas-calendar');
    expect(consentRequiredSchema.additionalProperties).toBe(false);
  });

  it('refuses an IdP consent that names a connector', () => {
    // The two are told apart by the presence of the field, so an IdP reply carrying one
    // would be read by the Automation App as an external consent and sent to the Bridge.
    expect(() => assertConsent({
      status: 'IDP_CONSENT_REQUIRED', transaction_id: 'txn_a', consent_url: 'https://human-idp.test/authorize',
      connector_id: 'stub-saas-calendar', extra: true,
    })).toThrow(SchemaValidationError);
    const idp = buildConsentResponse({
      status: 'IDP_CONSENT_REQUIRED', transactionId: 'txn_a',
      consentUrl: 'https://human-idp.test/authorize', connectorId: 'stub-saas-calendar',
      provisionerHost: 'provisioner.test',
    });
    expect(idp).not.toHaveProperty('connector_id');
  });

  it('refuses to send the browser to itself', () => {
    expect(() => buildConsentResponse({
      status: 'IDP_CONSENT_REQUIRED', transactionId: 'txn_a',
      consentUrl: `${PROVISIONER_BASE}/consent`, provisionerHost: new URL(PROVISIONER_BASE).host,
    })).toThrow(InvalidConsentUrl);
  });

  it('answers 200 with a url on another host, and starts nothing', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk, idpConnectionStatus: 'CONSENT_REQUIRED' });
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480 });

    expect(response.status).toBe(200);
    const body = await response.json() as ConsentRequired;
    expect(() => assertConsent(body)).not.toThrow();
    expect(body.status).toBe('IDP_CONSENT_REQUIRED');
    expect(new URL(body.consent_url).host).not.toBe(new URL(PROVISIONER_BASE).host);
    expect(target.jobRuns).toHaveLength(0);
  });

  /**
   * A self-hosted consent URL is a configuration error, and it is answered as one: a
   * 500 rather than a 200 the caller would happily redirect a person to and watch fail.
   */
  it('turns a self-hosted consent url into a 500 rather than a broken redirect', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    await seedDecision(target, { capabilities: ['document.read'] });
    const { createCatalogRepository } = await import('../src/catalog/repository.js');
    const { provisionAgent } = await import('../src/provisioning/flow.js');

    const outcome = await provisionAgent({
      ...target.deps,
      logger: target.deps.logger!,
      catalogue: createCatalogRepository(target.documents),
      agentOp: {
        ...target.deps.agentOp,
        // An Agent OP misconfigured to point the browser back at this service.
        async createIdpConnection() {
          return { status: 'CONSENT_REQUIRED' as const, consentUrl: `${PROVISIONER_BASE}/consent` };
        },
      },
    }, {
      humanSubject: 'testuser', taskId: 't', effectiveCapabilities: ['document.read'],
      isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', minutes: 480 },
    });

    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({ error: 'internal_error' });
    expect(target.jobRuns).toHaveLength(0);
  });
});
