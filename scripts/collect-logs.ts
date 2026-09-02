#!/usr/bin/env node
/**
 * T-SEC-10. Collects what the platform logged during an e2e run into one JSONL file.
 *
 * It reads BigQuery rather than `gcloud logging read`. The sink is what the detection
 * side actually consumes, so a line that never reached the sink is a line the platform
 * cannot detect on — and reading the log API instead would quietly pass on records that
 * the sink's filter drops.
 *
 * The output is `e2e/artifacts/logs.jsonl`, one JSON object per line, which is what
 * `no-raw-secret.spec.ts` scans and what CI keeps as a build artefact.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const OUTPUT_PATH = 'e2e/artifacts/logs.jsonl';

/** The sink's own destination table, created by Cloud Logging and not by Terraform. */
export const SINK_TABLE = 'security_audit.run_googleapis_com_stdout';

export function collectQuery(): string {
  return `SELECT TO_JSON_STRING(t) FROM \`${SINK_TABLE}\` AS t WHERE _PARTITIONTIME >= TIMESTAMP(@since)`;
}

export interface CollectOptions {
  since: string;
  /** Runs the query and returns one JSON string per row. */
  query(sql: string, params: { since: string }): Promise<string[]>;
  output?: string;
}

export async function collectLogs(options: CollectOptions): Promise<number> {
  const rows = await options.query(collectQuery(), { since: options.since });
  const path = options.output ?? OUTPUT_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.length === 0 ? '' : `${rows.join('\n')}\n`, 'utf8');
  return rows.length;
}

async function bigQuery(sql: string, params: { since: string }): Promise<string[]> {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const client = new BigQuery({ projectId: process.env.PROJECT_ID ?? '' });
  const [rows] = await client.query({ query: sql, params, location: process.env.REGION ?? 'asia-northeast1' });
  return (rows as Array<Record<string, string>>).map((row) => Object.values(row)[0] ?? '');
}

async function main(): Promise<void> {
  // Default window: the last hour, which comfortably covers one e2e run.
  const since = process.argv[2] ?? new Date(Date.now() - 3_600_000).toISOString();
  const written = await collectLogs({ since, query: bigQuery });
  process.stdout.write(`${JSON.stringify({ output: OUTPUT_PATH, lines: written, since })}\n`);
}

if (process.argv[1]?.endsWith('collect-logs.ts')) await main();
