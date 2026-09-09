import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import {
  drainActivityQueueForTesting, publishActivityEvent, resetActivityPublisherForTesting, type ActivityEvent,
} from '@xaa/contracts';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE } from '@xaa/provisioner/src/testing/harness';
import { ACTIVITY_COLLECTION, buildActivityPath } from '@xaa/automation-app/src/activity/subscriber';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AUTOMATION_APP_BASE, mintPushIdentity, startAutomationAppHarness } from '../../harness/automation-app.js';

const HUMAN_SUBJECT = 'testuser';

/**
 * The same bound-token construction e2e/test/provisioning/provisioning-flow.spec.ts
 * uses for the Provisioner audience: a real Human IdP authorization-code exchange, so
 * the request the Provisioner sees is the one production would see.
 */
async function provisionerToken(): Promise<{ token: string; keyPair: Es256KeyPair }> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: 'openid agent:provision', issuer: HUMAN_IDP_ISSUER, audience: 'agent-provisioner',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  const body = await response.json() as { access_token: string };
  return { token: body.access_token, keyPair };
}

function activityKind(event: ActivityEvent): unknown {
  return (event.detail as { activity_kind?: unknown } | undefined)?.activity_kind;
}

/**
 * T-IAC-28. Every other Provisioner test hands `publishActivity` a recording stub that
 * never leaves the process (apps/provisioner/src/testing/harness.ts), and every other
 * Automation App push test either omits the caller's token (activity.spec.ts's 401
 * case) or skips the route and calls `storeActivityEvent` directly (timeline.spec.ts).
 * Neither exercises the one hop docs 11 promises: a Provisioner event riding the real
 * `@xaa/contracts` in-process queue (PUBSUB_MODE=inproc) into a push delivery the
 * Automation App accepts and stores. This is that path, end to end.
 */
describe('a Provisioner event reaches the person\'s own timeline', () => {
  it('drains an AGENT_PROVISIONED event into users/{human_subject}/activity', async () => {
    resetActivityPublisherForTesting();

    // Wired to the real publisher, not the array the harness records by default: the
    // events this test drains must be the ones that sat on the same in-process queue
    // the Automation App's Pub/Sub subscription reads from in production.
    const provisioner = await createProvisionerHarness({
      idpPublicJwk: await idpPublicJwk(),
      publishActivity: publishActivityEvent,
    });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const caller = await provisionerToken();

    const provisioned = await provisioner.fetch('/provisioning', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 }),
    });
    expect(provisioned.status).toBe(201);

    const published = drainActivityQueueForTesting();
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((event) => event.source === 'provisioner')).toBe(true);
    expect(published.every((event) => event.human_subject === HUMAN_SUBJECT)).toBe(true);

    // The Automation App's push endpoint, authenticated the way a real Pub/Sub delivery
    // is: an OIDC token for a Google service account, verified against a JWKS this test
    // serves over `fetchImpl` rather than https://www.googleapis.com. The token's
    // audience is the app's `https://` public base URL, because that is what T-IAC-28
    // configures on the subscription.
    const identity = await mintPushIdentity({ audience: AUTOMATION_APP_BASE });
    const automation = await startAutomationAppHarness({
      humanSubject: HUMAN_SUBJECT,
      upstream: (url) => (url === 'https://www.googleapis.com/oauth2/v3/certs'
        ? Response.json(identity.jwks)
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    });

    // Delivered over `http://`, which is what the container actually sees: Cloud Run
    // terminates TLS at its front end and forwards plain HTTP/1.1. The endpoint must
    // still check the token against the configured `https://` audience above.
    const pushUrl = `${AUTOMATION_APP_BASE.replace('https://', 'http://')}/internal/activity/push`;
    for (const event of published) {
      const response = await automation.fetch(pushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
        body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(event)).toString('base64') } }),
      });
      expect(response.status).toBe(200);
    }

    // The row this test is about: the one Provisioner event that marks the agent
    // active, landed at exactly the path a person's timeline reads from.
    const provisionedEvent = published.find((event) => activityKind(event) === 'AGENT_PROVISIONED');
    expect(provisionedEvent).toBeDefined();
    expect(buildActivityPath(provisionedEvent!.human_subject, provisionedEvent!.event_id))
      .toBe(`users/${HUMAN_SUBJECT}/activity/${provisionedEvent!.event_id}`);

    const stored = await automation.documents.get<ActivityEvent>(ACTIVITY_COLLECTION, provisionedEvent!.event_id);
    expect(stored).toBeDefined();
    expect(stored!.human_subject).toBe(HUMAN_SUBJECT);
    expect(activityKind(stored!)).toBe('AGENT_PROVISIONED');

    // And it is not merely the last row written: every drained event round-tripped.
    const rows = await automation.documents.queryEqual(ACTIVITY_COLLECTION, [['human_subject', HUMAN_SUBJECT]]);
    expect(rows).toHaveLength(published.length);
  });
});
