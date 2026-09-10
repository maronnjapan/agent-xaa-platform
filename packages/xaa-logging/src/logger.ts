import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { attachCorrelationKeys } from './correlation.js';
import { LOG_SOURCES, type AppName, type LogContext, type LogEntry, type Logger, type LogSeverity } from './types.js';

const Ajv = (AjvModule as unknown as { default?: new (options?: object) => import('ajv').default }).default ?? AjvModule as unknown as new (options?: object) => import('ajv').default;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const schema = {
  type: 'object', additionalProperties: false,
  required: ['severity', 'app', 'log_source', 'event', 'request_id', 'trace_id', 'agent_id', 'human_subject', 'timestamp', 'fields'],
  properties: {
    severity: { enum: ['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL'] }, app: { type: 'string', minLength: 1 },
    log_source: { enum: LOG_SOURCES }, event: { type: 'string', minLength: 1 }, request_id: { type: 'string' }, trace_id: { type: 'string' },
    agent_id: { type: ['string', 'null'] }, human_subject: { type: ['string', 'null'] }, timestamp: { type: 'string', format: 'date-time' },
    fields: { type: 'object', additionalProperties: true },
  },
} as const;
const ajv = new Ajv({ strict: true });
(addFormats as unknown as (instance: import('ajv').default, formats?: string[]) => void)(ajv, ['date-time']);
const validate: ValidateFunction<LogEntry> = ajv.compile(schema);

export function assertLogEntry(value: unknown): asserts value is LogEntry {
  if (!validate(value)) throw new Error('invalid structured log entry');
}

let sink: ((line: string) => void) | undefined;

/**
 * Where lines go when the process is not a Cloud Run container.
 *
 * On GCP a line written to stdout is picked up by Cloud Logging, and the Log Sink is
 * what carries it to Security Detection. Off GCP there is no such pipe, so a host that
 * runs the platform itself installs one here: every logger that was not handed an
 * explicit sink writes through it, which is what lets the local runner feed the
 * detector the same stream the deployment feeds it. Clearing it restores stdout.
 *
 * A logger built with an explicit `write` — every test in this repository — is
 * unaffected either way.
 */
export function setLogSink(next: ((line: string) => void) | undefined): void { sink = next; }

/** Read at write time, not at construction, so a sink installed later still takes effect. */
function writeToSinkOrStdout(line: string): void {
  if (sink) sink(line);
  else process.stdout.write(line);
}

export function createLogger(app: AppName, source: LogEntry['log_source'], write: (line: string) => void = writeToSinkOrStdout): Logger {
  const log = (severity: LogSeverity, event: string, ctx: LogContext, fields: Record<string, unknown> = {}): void => {
    const entry: LogEntry = { severity, app, log_source: source, event, ...ctx, timestamp: new Date().toISOString(), fields: attachCorrelationKeys(fields) };
    if (process.env.NODE_ENV !== 'production') assertLogEntry(entry);
    write(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (event, ctx, fields) => log('INFO', event, ctx, fields),
    warning: (event, ctx, fields) => log('WARNING', event, ctx, fields),
    error: (event, ctx, fields) => log('ERROR', event, ctx, fields),
    critical: (event, ctx, fields) => log('CRITICAL', event, ctx, fields),
  };
}
