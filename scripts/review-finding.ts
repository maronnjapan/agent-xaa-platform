#!/usr/bin/env node
/**
 * T-SEC-35. Approve or reject one pending Security Finding.
 *
 * A CLI rather than a screen. The decision is rare, it is made by an operator who
 * already has gcloud, and a page would need its own authentication, its own audience and
 * its own place in the Automation App — which is the person's workspace, not the
 * platform's console. Two arguments and nothing else: this script never writes Firestore
 * or BigQuery directly, because a decision that bypassed the endpoint would skip the
 * transition request the endpoint makes.
 *
 * Usage: review-finding.ts <finding_id> approve|reject
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const DECISIONS = ['approve', 'reject'] as const;
type Decision = (typeof DECISIONS)[number];

export interface ReviewOptions {
  findingId: string;
  decision: Decision;
  baseUrl: string;
  reviewer: string;
  identityToken: string;
  fetchImpl?: typeof fetch;
}

export function parseArguments(argv: readonly string[]): { findingId: string; decision: Decision } {
  if (argv.length !== 2) throw new Error('usage: review-finding.ts <finding_id> approve|reject');
  const [findingId, decision] = argv;
  if (!DECISIONS.includes(decision as Decision)) throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
  return { findingId: findingId!, decision: decision as Decision };
}

export async function reviewFinding(options: ReviewOptions): Promise<number> {
  const send = options.fetchImpl ?? globalThis.fetch;
  const response = await send(`${options.baseUrl}/internal/review/${options.findingId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${options.identityToken}` },
    body: JSON.stringify({ decision: options.decision, reviewer: options.reviewer }),
  });
  return response.status;
}

/** The operator's own identity, as Cloud Run's OIDC check will see it. */
async function identityToken(audience: string): Promise<string> {
  const { stdout } = await promisify(execFile)('gcloud', [
    'auth', 'print-identity-token', `--audiences=${audience}`,
  ]);
  return stdout.trim();
}

async function main(): Promise<void> {
  const { findingId, decision } = parseArguments(process.argv.slice(2));
  const baseUrl = process.env.SECURITY_DETECTION_URL;
  if (!baseUrl) throw new Error('SECURITY_DETECTION_URL is required');
  const reviewer = process.env.REVIEWER ?? process.env.USER ?? 'unknown';

  const status = await reviewFinding({
    findingId, decision, baseUrl, reviewer,
    identityToken: await identityToken(baseUrl),
  });
  process.stdout.write(`${JSON.stringify({ finding_id: findingId, decision, status })}\n`);
  // 409 means somebody already decided; that is an answer, not a transport failure, and
  // the exit code says so without the caller parsing the body.
  process.exitCode = status === 200 ? 0 : 1;
}

if (process.argv[1]?.endsWith('review-finding.ts')) await main();
