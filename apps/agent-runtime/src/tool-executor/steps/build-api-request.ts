import type { ToolDefinition } from '../../manifest/load.js';
import type { ToolFailed } from '../errors.js';

export interface ApiRequest {
  url: string;
  method: string;
  body: string | undefined;
  droppedParameters: string[];
}

interface ParameterSpec { required?: boolean }

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g;

/**
 * step6. The request the resource will see, built only from the manifest and the
 * named parameters.
 *
 * Three failures are closed here, in order, before anything is sent (REQ-04-022):
 * a missing required parameter, a key the manifest never declared, and a path
 * parameter that climbs out of `base_url`. The traversal check runs on the *parsed*
 * URL rather than on the string, because `..` is only resolved once a URL parser has
 * seen it — checking the template would miss `primary/../../admin` entirely.
 *
 * Undeclared keys are dropped rather than rejected: the model may name something
 * harmless, and the drop is reported to the stage log so the omission is visible.
 */
export function buildApiRequest(
  tool: ToolDefinition,
  parameters: Record<string, unknown>,
): ApiRequest | ToolFailed {
  const declared = tool.parameters as Record<string, ParameterSpec>;

  for (const [name, spec] of Object.entries(declared)) {
    if (spec?.required === true && parameters[name] === undefined) {
      return {
        outcome: 'failed', reason: `missing_required_parameter:${name}`,
        error_code: 'missing_required_parameter', tool_id: tool.tool_id, stage: 'resource_api',
      };
    }
  }

  const droppedParameters: string[] = [];
  const accepted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (name in declared) accepted[name] = value; else droppedParameters.push(name);
  }

  const consumed = new Set<string>();
  const path = tool.api.path.replace(PLACEHOLDER, (_match, name: string) => {
    consumed.add(name);
    return encodeURIComponent(String(accepted[name] ?? ''));
  });

  const base = new URL(tool.api.base_url);
  const url = new URL(path, base);
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (url.origin !== base.origin || !`${url.pathname}/`.startsWith(basePath)) {
    return {
      outcome: 'failed', reason: 'invalid_path_parameter', error_code: 'invalid_path_parameter',
      tool_id: tool.tool_id, stage: 'resource_api',
    };
  }

  const remaining = Object.entries(accepted).filter(([name]) => !consumed.has(name));
  if (tool.api.method === 'GET') {
    for (const [name, value] of remaining) url.searchParams.set(name, String(value));
    return { url: url.toString(), method: tool.api.method, body: undefined, droppedParameters };
  }
  return {
    url: url.toString(),
    method: tool.api.method,
    body: JSON.stringify(Object.fromEntries(remaining)),
    droppedParameters,
  };
}
