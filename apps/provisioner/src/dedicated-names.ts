/**
 * DEC-IAC-08. The boundary between what Terraform owns and what runs-time code may
 * touch is drawn by name. These six prefixes are the whole of the runtime name space.
 */
export const RUNTIME_NAME_PREFIXES = [
  'dedicated-op-', 'sa-op-', 'sa-agent-', 'idjag-', 'idpconn-', 'agent-runtime-',
] as const;

export class ForbiddenRuntimeName extends Error {
  constructor(readonly name: string) {
    super(`refusing to touch a resource outside the runtime name space: ${name}`);
  }
}

/**
 * Every create, update and delete call passes through here. A Terraform-managed name
 * such as `human-idp` has no runtime prefix, so it cannot be reached even by a
 * caller that has the IAM permission.
 */
export function assertRuntimeName(name: string): string {
  const leaf = name.split('/').pop() ?? name;
  if (!RUNTIME_NAME_PREFIXES.some((prefix) => leaf.startsWith(prefix))) throw new ForbiddenRuntimeName(name);
  return name;
}

/** DEC-IAC-07: the last twelve characters of the agent id's random part. */
export function shortId(agentId: string): string {
  return agentId.slice(-12);
}

/**
 * The six names a FULL_ISOLATION agent owns. Service account ids must be 6..30
 * characters: `sa-op-` plus twelve is eighteen, `sa-agent-` plus twelve is
 * twenty-one, both comfortably inside.
 */
export function dedicatedNames(agentId: string) {
  const short = shortId(agentId);
  return {
    short,
    opServiceAccount: `sa-op-${short}`,
    agentServiceAccount: `sa-agent-${short}`,
    signingKey: `idjag-${short}`,
    connectionKey: `idpconn-${short}`,
    opService: `dedicated-op-${short}`,
    runtimeJob: `agent-runtime-${short}`,
  } as const;
}

/** DEC-IAC-25. Both labels, on everything, so the sweep can find it later. */
export function runtimeLabels(agentId: string): Record<string, string> {
  return { 'xaa-managed': 'runtime', 'xaa-agent-id': agentId };
}

/** Service accounts carry no labels, so the same facts go into the description. */
export function runtimeDescription(agentId: string): string {
  return `xaa-managed=runtime agent=${agentId}`;
}
