import { JobsClient, ServicesClient } from '@google-cloud/run';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { GoogleAuth } from 'google-auth-library';
import { runtimeDescriptionAgentId, runtimeLabelAgentId } from '@xaa/contracts';
import { destroyRuntimeResource } from '../cleanup/steps/dedicated-destroy.js';
import type { CleanupClients } from './types.js';
import type { LabelledResource, SweepDeps } from '../sweep.js';

/**
 * The two key rings Terraform provides. Runtime keys are created inside them and never
 * anywhere else, so this is the whole of where an orphaned key can be.
 */
const KEY_RINGS = ['idjag-signing', 'idp-connection-encryption'] as const;

/**
 * Stage (e) of the sweep, against the real project (DEC-IAC-25).
 *
 * This is the only path that can reach a resource the Provisioner created and then
 * failed to record: the ledger in `dedicated_resources` is written per resource, but a
 * process that dies between the create call and the write leaves a live Cloud Run
 * service that nothing points at. The labels are mandatory at creation time precisely
 * so that this listing can find it afterwards.
 *
 * Nothing here decides what to delete. The listing answers "which resources are ours,
 * and whose", and `sweep()` compares that against the agents in Firestore; a resource
 * whose agent is still alive is left where it is. Deleting goes through
 * `destroyRuntimeResource`, so the `assertRuntimeName` guard is the same one the ledger
 * walk passes — a listing that somehow returned `human-idp` would raise rather than
 * delete it.
 *
 * Every listing is best-effort. A missing permission or a key ring in another region
 * must degrade to "collected nothing this tick", not to a tick that throws and leaves
 * the four stages before it unreported.
 */
export function createOrphanCollector(input: {
  projectId: string;
  region: string;
  clients: Pick<CleanupClients, 'cloudRun' | 'kms' | 'iam' | 'jwks'>;
  services?: ServicesClient;
  jobs?: JobsClient;
  kms?: KeyManagementServiceClient;
  auth?: GoogleAuth;
}): Required<Pick<SweepDeps, 'listLabelledResources' | 'deleteResource'>> {
  const services = input.services ?? new ServicesClient();
  const jobs = input.jobs ?? new JobsClient();
  const kms = input.kms ?? new KeyManagementServiceClient();
  const auth = input.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const parent = `projects/${input.projectId}/locations/${input.region}`;

  return {
    async listLabelledResources(): Promise<LabelledResource[]> {
      const found = await Promise.all([
        labelled(() => services.listServices({ parent }), 'cloud_run_service'),
        labelled(() => jobs.listJobs({ parent }), 'cloud_run_job'),
        ...KEY_RINGS.map((ring) => labelled(
          () => kms.listCryptoKeys({ parent: `${parent}/keyRings/${ring}` }), 'crypto_key',
        )),
        serviceAccounts(auth, input.projectId),
      ]);
      return found.flat();
    },

    async deleteResource(resource: LabelledResource): Promise<void> {
      await destroyRuntimeResource(input.clients, resource.kind, resource.name);
    },
  };
}

interface Labelled { name?: string | null; labels?: Record<string, string> | null }

/** Cloud Run and KMS all answer with `[items, ...]` and carry the labels directly. */
async function labelled(
  list: () => Promise<unknown>, kind: LabelledResource['kind'],
): Promise<LabelledResource[]> {
  const response = await list().catch(() => undefined) as [Labelled[]] | undefined;
  return (response?.[0] ?? []).flatMap((item) => {
    const agentId = runtimeLabelAgentId(item.labels);
    return item.name && agentId ? [{ name: item.name, kind, agentId }] : [];
  });
}

/**
 * Service accounts carry no labels at all, so the same two facts were written into the
 * description at creation time. The email is what the delete call wants.
 */
async function serviceAccounts(auth: GoogleAuth, projectId: string): Promise<LabelledResource[]> {
  const response = await auth.request<{ accounts?: Array<{ email?: string; description?: string }> }>({
    url: `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`,
  }).catch(() => undefined);
  return (response?.data.accounts ?? []).flatMap((account) => {
    const agentId = runtimeDescriptionAgentId(account.description);
    return account.email && agentId
      ? [{ name: account.email, kind: 'service_account' as const, agentId }]
      : [];
  });
}
