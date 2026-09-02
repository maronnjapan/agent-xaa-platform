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

/**
 * DEC-IAC-25. The two labels every runtime-created resource carries.
 *
 * They exist for the sweep, not for the ledger: a Provisioner that died between
 * creating a resource and recording it leaves nothing in `dedicated_resources`, and
 * the label is then the only thing that says who the resource belonged to.
 */
export const RUNTIME_LABEL_KEY = 'xaa-managed';
export const RUNTIME_LABEL_VALUE = 'runtime';
export const RUNTIME_AGENT_LABEL_KEY = 'xaa-agent-id';

/** DEC-IAC-25. Both labels, on everything, so the sweep can find it later. */
export function runtimeLabels(agentId: string): Record<string, string> {
  return { [RUNTIME_LABEL_KEY]: RUNTIME_LABEL_VALUE, [RUNTIME_AGENT_LABEL_KEY]: agentId };
}

/** Service accounts carry no labels, so the same facts go into the description. */
export function runtimeDescription(agentId: string): string {
  return `${RUNTIME_LABEL_KEY}=${RUNTIME_LABEL_VALUE} agent=${agentId}`;
}

/**
 * The read side of the two writers above: which agent a resource belongs to, or null
 * when it is not one of ours.
 *
 * Returning null rather than throwing is deliberate — these read a listing of a whole
 * project, most of which is Terraform's, and a Terraform-managed service is not an
 * error to encounter. It is simply not a candidate.
 */
export function runtimeLabelAgentId(labels: Readonly<Record<string, string>> | null | undefined): string | null {
  if (labels?.[RUNTIME_LABEL_KEY] !== RUNTIME_LABEL_VALUE) return null;
  return labels[RUNTIME_AGENT_LABEL_KEY] ?? null;
}

/** The same fact recovered from a service account's description. */
export function runtimeDescriptionAgentId(description: string | null | undefined): string | null {
  if (!description?.startsWith(`${RUNTIME_LABEL_KEY}=${RUNTIME_LABEL_VALUE} `)) return null;
  return /(?:^|\s)agent=(\S+)/.exec(description)?.[1] ?? null;
}
