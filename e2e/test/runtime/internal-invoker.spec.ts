import { describe, expect, it } from 'vitest';
import { executeTool } from '@xaa/agent-runtime/src/tool-executor/index';
import { buildInternalOrigins } from '@xaa/agent-runtime/src/http/allowed-hosts';
import { seedDocument } from '../../harness/resource.js';
import { docsRuntime } from './runtime-flow-docs.spec.js';

/**
 * REQ-08-021 / DEC-IAC-15. The Cloud Run IAM check the Runtime has to get past before
 * any of its own credentials are read.
 *
 * `infra/envs/demo/locals-invoker.tf` grants `sa-agent-runtime` `roles/run.invoker` on
 * the Shared OP, the Native AS and the Resource API. The Runtime presented its token
 * at the first only, so an Execution reached `/xaa/subject-token` and `/xaa/token`,
 * minted an ID-JAG, and was refused at the Resource AS door with
 * `Empty Authorization header value` — a 403 from Cloud Run's front end, logged by
 * the AS's revision and never by the app, which had not run.
 *
 * The assertions do not repeat the list of doors. The harness puts Cloud Run's check
 * in front of every app it routes to, so a door the Runtime does not open is a hop
 * that fails; and the set is checked against the manifest that named the hop, because
 * a destination added to one and not the other is the whole of this failure.
 */
describe('the invoker token, on the doors Terraform grants', () => {
  it('opens the Resource AS and the Resource API, not only the Agent OP', async () => {
    const { runtime, docs } = await docsRuntime();
    await seedDocument(docs, 'testuser');

    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: (line) => runtime.stageLines.push(line),
    }, { tool_id: 'internal.document.list', parameters: {} });

    expect(result).toMatchObject({ outcome: 'success' });
    // One token per door, and the audience is the service's own origin: Cloud Run
    // checks the ID Token's `aud` against the URL it is presented at.
    expect([...new Set(runtime.invokerAudiences)].sort()).toEqual([
      new URL(runtime.context.agentOpBaseUrl).origin,
      new URL(docs.asIssuer).origin,
      new URL(docs.resourceUri).origin,
    ].sort());
  });

  it('names every origin the manifest sends the Execution to', async () => {
    const { runtime } = await docsRuntime();
    const origins = buildInternalOrigins(
      { AGENT_OP_BASE_URL: runtime.context.agentOpBaseUrl }, runtime.context.manifest,
    );

    expect(origins.has(new URL(runtime.context.agentOpBaseUrl).origin)).toBe(true);
    for (const tool of runtime.context.manifest.tools) {
      expect(origins.has(new URL(tool.authorization.audience).origin)).toBe(true);
      expect(origins.has(new URL(tool.api.base_url).origin)).toBe(true);
    }
  });
});
