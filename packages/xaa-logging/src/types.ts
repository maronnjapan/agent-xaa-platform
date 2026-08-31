export const LOG_SOURCES = [
  'human_idp',
  'authz_ai',
  'policy_engine',
  'provisioner',
  'agent_op',
  'agent_op_idp_connection',
  'google_bridge',
  'native_resource_as',
  'resource_api',
  'agent_runtime',
] as const;

export type LogSource = (typeof LOG_SOURCES)[number];
export type LogSeverity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type AppName = string;

export interface LogContext {
  request_id: string;
  trace_id: string;
  agent_id: string | null;
  human_subject: string | null;
}

export interface LogEntry extends LogContext {
  severity: LogSeverity;
  app: AppName;
  log_source: LogSource;
  event: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  info(event: string, ctx: LogContext, fields?: Record<string, unknown>): void;
  warning(event: string, ctx: LogContext, fields?: Record<string, unknown>): void;
  error(event: string, ctx: LogContext, fields?: Record<string, unknown>): void;
  critical(event: string, ctx: LogContext, fields?: Record<string, unknown>): void;
}
