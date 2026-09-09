import { describe, expect, it } from 'vitest';
import {
  AGENT_ID, CONSOLE_BASE, OTHER_AGENT_ID, SUBJECT, config, startConsole, storedFinding, type Harness,
} from './helpers.js';
import { readAgentStates, readFindingsFor } from '../src/findings/read.js';
import { CONSOLE_AGENT_GONE, CONSOLE_EMPTY } from '../src/ui/pages/findings.js';
import { FINDING_NOT_ANALYSED, FINDING_NO_ANALYSIS } from '../src/ui/components/finding-card.js';

const OTHER_SUBJECT = 'someone-else';

async function seed(harness: Harness, finding: Record<string, unknown>): Promise<void> {
  await harness.detectorSeed.set('security_findings', String(finding.finding_id), finding);
}

async function seedAgent(harness: Harness, options: { agentId?: string; humanSubject?: string; status?: string } = {}): Promise<void> {
  await harness.provisionerSeed.set('agents', `${options.agentId ?? AGENT_ID}__meta`, {
    agent_id: options.agentId ?? AGENT_ID,
    human_subject: options.humanSubject ?? SUBJECT,
    status: options.status ?? 'QUARANTINED',
    expires_at: '2026-01-02T00:00:00.000Z',
  });
}

/**
 * The console, as it is actually served.
 *
 * It is a separate deployment with its own login, and the two halves that matter are
 * whether it decides who is asking exactly once, and whether what the detector decided
 * reaches the page unaltered — minus the evidence a browser must never be handed.
 */
describe('the screen', () => {
  it('is served as HTML with its stylesheet', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    const response = await harness.fetch('/', { headers: { cookie: await harness.signIn() } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('data-page="findings"');
    expect(body).toContain('href="/styles/console.css"');
    expect((await harness.fetch('/styles/console.css')).headers.get('content-type')).toContain('text/css');
  });

  it("prints the analyser's own words and its verdict", async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain('他の OP へ届いています');
    expect(body).toContain('権限の範囲を超えています');
    expect(body).toContain('同一 trace です');
    expect(body).toContain('共有 OP への波及なし');
    expect(body).toContain('data-risk-level="CRITICAL"');
    expect(body).toContain('isolation.dedicated_op_mismatch');
    expect(body).toContain('侵害の可能性');
    expect(body).toContain('82%');
  });

  it('hands the browser the judgement and none of the evidence behind it', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).not.toContain('trace-1');
    expect(body).not.toContain('corr-1');
    expect(body).not.toContain('related_events');
  });

  it("shows nobody else's finding, whoever the agent belongs to", async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding({ finding_id: 'f_mine' }));
    await seed(harness, storedFinding({
      finding_id: 'f_theirs', human_subject: OTHER_SUBJECT, agent_id: OTHER_AGENT_ID,
    }));
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain('data-finding-id="f_mine"');
    expect(body).not.toContain('data-finding-id="f_theirs"');
  });

  it("names what became of the agent, and says so when it is gone", async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    await seedAgent(harness, { status: 'QUARANTINED' });
    await seed(harness, storedFinding({ finding_id: 'f_orphan', agent_id: OTHER_AGENT_ID }));
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain('QUARANTINED');
    // The second agent's registration is gone; its findings stay and say so.
    expect(body).toContain(CONSOLE_AGENT_GONE);
  });

  it("does not read a registration that names somebody else's subject", async () => {
    const harness = await startConsole();
    await seedAgent(harness, { humanSubject: OTHER_SUBJECT, status: 'ACTIVE' });
    const states = await readAgentStates({
      documents: harness.documents, agentIds: [AGENT_ID], humanSubject: SUBJECT,
    });
    expect(states.size).toBe(0);
  });

  it('links each agent to where it is operated, which is the other app', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain(`${config.automationAppUrl}/agents/${AGENT_ID}`);
  });

  it('says so when the analyser has recorded nothing about this person', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding({ finding_id: 'f_theirs', human_subject: OTHER_SUBJECT }));
    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain(CONSOLE_EMPTY);
  });
});

describe('who is asking', () => {
  it('sends a visitor with no session to the login', async () => {
    const harness = await startConsole();
    const response = await harness.fetch('/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('sends a visitor with an unknown or expired session to the login', async () => {
    const harness = await startConsole();
    const unknown = await harness.fetch('/', { headers: { cookie: 'xaa_console_session=nope' } });
    expect(unknown.headers.get('location')).toBe('/login');

    const expired = await startConsole({ now: () => Date.parse('2026-01-01T00:00:00.000Z') });
    const cookie = await expired.signIn();
    // The session store stamps its expiry from the real clock; the app is an hour past it.
    const later = await startConsole({ now: () => Date.now() + 7_200_000 });
    const response = await later.fetch('/', { headers: { cookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('starts the code flow with PKCE, a nonce, and no scope it cannot use', async () => {
    const harness = await startConsole();
    const response = await harness.fetch('/login');
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(target.origin + target.pathname).toBe(`${config.issuer}/authorize`);
    expect(target.searchParams.get('client_id')).toBe('analysis-console');
    expect(target.searchParams.get('redirect_uri')).toBe(`${CONSOLE_BASE}/callback`);
    expect(target.searchParams.get('scope')).toBe('openid profile');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toBeTruthy();
    expect(target.searchParams.get('nonce')).toBeTruthy();
    expect(target.searchParams.get('state')).toBeTruthy();
  });

  it('exchanges the code and starts a session for the subject the ID Token names', async () => {
    const harness = await startConsole();
    const request = await harness.beginLogin();
    harness.setIdTokenClaims({ sub: SUBJECT, nonce: request.get('nonce')! });

    const response = await harness.fetch(`/callback?code=the-code&state=${request.get('state')!}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^xaa_console_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);

    // The session it just made is the one the screen honours, and it names this person.
    const page = await harness.fetch('/', { headers: { cookie: cookie.split(';')[0]! } });
    expect(page.status).toBe(200);
  });

  it('redeems the code with a client secret and no DPoP proof', async () => {
    // The console holds no operation scope, so the Human IdP requires no proof — and
    // this app has no DPoP key to make one with, by design.
    const harness = await startConsole();
    const request = await harness.beginLogin();
    harness.setIdTokenClaims({ sub: SUBJECT, nonce: request.get('nonce')! });
    await harness.fetch(`/callback?code=the-code&state=${request.get('state')!}`);

    const exchange = harness.upstream.find((call) => call.url.endsWith('/token'))!;
    const headers = exchange.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers.DPoP).toBeUndefined();
    expect(String(exchange.init.body)).toContain('grant_type=authorization_code');
    expect(String(exchange.init.body)).toContain('code_verifier=');
  });

  it('refuses a callback whose ID Token answers a different login', async () => {
    const harness = await startConsole();
    const request = await harness.beginLogin();
    harness.setIdTokenClaims({ sub: SUBJECT, nonce: 'some-other-login' });
    const response = await harness.fetch(`/callback?code=the-code&state=${request.get('state')!}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'invalid_id_token' });
  });

  it('refuses a state it never issued, and the same state twice', async () => {
    const harness = await startConsole();
    expect((await harness.fetch('/callback?code=c&state=never-issued')).status).toBe(400);

    const request = await harness.beginLogin();
    harness.setIdTokenClaims({ sub: SUBJECT, nonce: request.get('nonce')! });
    expect((await harness.fetch(`/callback?code=c&state=${request.get('state')!}`)).status).toBe(302);
    // A second use finds the transaction already consumed rather than minting a second
    // session for the same authorization code.
    expect((await harness.fetch(`/callback?code=c&state=${request.get('state')!}`)).status).toBe(400);
  });

  it('refuses a token response the Human IdP would not have produced', async () => {
    const refused = await startConsole({ upstreamHandler: () => new Response('{}', { status: 401 }) });
    const first = await refused.beginLogin();
    expect((await refused.fetch(`/callback?code=c&state=${first.get('state')!}`)).status).toBe(502);

    const empty = await startConsole({ upstreamHandler: () => new Response('{}', { status: 200 }) });
    const second = await empty.beginLogin();
    const response = await empty.fetch(`/callback?code=c&state=${second.get('state')!}`);
    expect(await response.json()).toEqual({ error: 'invalid_token_response' });
  });

  it('answers livez without a session', async () => {
    const harness = await startConsole();
    const response = await harness.fetch('/livez');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', app: 'analysis-console' });
  });
});

describe('what this app may touch', () => {
  it('may read the detector\'s findings and write none of them', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    expect(await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT })).toHaveLength(1);
    await expect(harness.documents.set('security_findings', 'f_x', {}))
      .rejects.toThrow(/Firestore access denied: analysis-console write/);
  });

  it("cannot reach the Automation App's sessions or a person's work", async () => {
    const harness = await startConsole();
    // Its own session collection is separate on purpose: one collection shared by two
    // apps would mean a session minted by either is honoured by both.
    await expect(harness.documents.get('sessions', 'anything'))
      .rejects.toThrow(/Firestore access denied: analysis-console read/);
    await expect(harness.documents.get('work_definitions', 'anything'))
      .rejects.toThrow(/Firestore access denied: analysis-console read/);
    await expect(harness.documents.get('user_activity', 'anything'))
      .rejects.toThrow(/Firestore access denied: analysis-console read/);
  });

  it('drops a row it cannot read rather than failing the whole screen', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding());
    await harness.detectorSeed.set('security_findings', 'f_no_id', {
      human_subject: SUBJECT, finding_id: '', agent_id: AGENT_ID,
    });
    await seed(harness, storedFinding({ finding_id: 'f_odd_type', finding_type: 'something_else' }));
    const findings = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    expect(findings.map((finding) => finding.finding_id)).toEqual(['f_1_abcdef01']);

    const body = await (await harness.fetch('/', { headers: { cookie: await harness.signIn() } })).text();
    expect(body).toContain('data-finding-id="f_1_abcdef01"');
    expect(body).not.toContain('data-finding-id="f_odd_type"');
  });

  it('answers newest first, and null for what the analysis stage has not written', async () => {
    const harness = await startConsole();
    await seed(harness, storedFinding({ finding_id: 'f_early', created_at: '2026-01-01T12:00:00.000Z' }));
    await seed(harness, storedFinding({
      finding_id: 'f_late', created_at: '2026-01-01T13:00:00.000Z', review_status: 'none',
      recommended_response: undefined, confidence: undefined,
      analysis: undefined, analysis_source: undefined, analyzed_at: undefined,
    }));
    const findings = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    expect(findings.map((finding) => finding.finding_id)).toEqual(['f_late', 'f_early']);
    expect(findings[0]).toMatchObject({
      recommended_response: null, confidence: null, analysis: null,
      analysis_source: null, analyzed_at: null,
    });
  });

  it('tells a missing analysis apart from one the model could not produce', async () => {
    const missing = await startConsole();
    await seed(missing, storedFinding({
      analysis: undefined, analysis_source: undefined, analyzed_at: undefined,
      recommended_response: undefined, confidence: undefined, review_status: 'none',
    }));
    expect(await (await missing.fetch('/', { headers: { cookie: await missing.signIn() } })).text())
      .toContain(FINDING_NOT_ANALYSED);

    // The model answered with something unusable and the risk level decided alone. A
    // screen showing this the same way as a real judgement would present a default as a
    // conclusion.
    const fallback = await startConsole();
    await seed(fallback, storedFinding({ analysis: undefined, analysis_source: 'fallback' }));
    const body = await (await fallback.fetch('/', { headers: { cookie: await fallback.signIn() } })).text();
    expect(body).toContain(FINDING_NO_ANALYSIS);
    expect(body).toContain('リスク値だけで決めた既定の対応');
  });
});
