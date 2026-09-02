import { assertValidCapabilityId } from '@xaa/contracts';
import { createFirestoreDocumentStore, getFirestore, type DocumentStore } from '@xaa/gcp';
import { AUTHZ_COLLECTIONS, humanPermissionId } from './store/collections.js';

/** 00b §3: the topic Authorization subscribes to for permission changes. */
export const PERMISSION_CHANGE_TOPIC = 'human-permission-changed';

export const PERM_SET_ACTIONS = ['grant', 'revoke'] as const;
export type PermSetAction = (typeof PERM_SET_ACTIONS)[number];

/**
 * REQ-07-027. `human_subject` and `changed_at` are what the receiver requires; the
 * capability and the direction are carried for the log, not for the re-evaluation,
 * which always recomputes from the permission table as it stands.
 */
export interface PermissionChangeMessage {
  human_subject: string;
  capability_id: string;
  action: PermSetAction;
  changed_at: string;
}

export interface PermSetDeps {
  documents: DocumentStore;
  publish(message: PermissionChangeMessage): Promise<void>;
  now(): number;
  error?(line: string): void;
}

const USAGE = 'usage: pnpm perm:set <human_subject> <capability_id> <grant|revoke>';

const memoryQueue: PermissionChangeMessage[] = [];

/** PUBSUB_MODE=inproc keeps the message here, where a test can read it (DEC-APP-09). */
export function drainPermissionChangeQueueForTesting(): PermissionChangeMessage[] {
  return memoryQueue.splice(0, memoryQueue.length);
}

/**
 * Grants or revokes one human permission and announces the change.
 *
 * A revocation is the removal of the row, not a flag on it: `human_permissions` is one
 * document per (subject, capability) precisely so that losing a permission is the
 * absence of a record rather than a state some reader could forget to check.
 *
 * The announcement is what makes the change reach agents that are already running —
 * Authorization re-evaluates from it (RULE-13) — so the write and the publish belong
 * to the same command. A rejected argument does neither: an unknown action must not
 * leave a permission changed and unannounced, or announced and unchanged.
 *
 * Returns the process exit code.
 */
export async function permSet(argv: string[], deps: PermSetDeps): Promise<number> {
  const report = deps.error ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const [humanSubject, capabilityId, action] = argv;
  if (argv.length !== 3 || !humanSubject || !capabilityId || !action) {
    report(USAGE);
    return 1;
  }
  if (!(PERM_SET_ACTIONS as readonly string[]).includes(action)) {
    report(`unknown action: ${action}`);
    report(USAGE);
    return 1;
  }
  try {
    assertValidCapabilityId(capabilityId);
  } catch {
    report(`invalid capability_id: ${capabilityId}`);
    return 1;
  }

  const changedAt = new Date(deps.now()).toISOString();
  const documentId = humanPermissionId(humanSubject, capabilityId);
  if (action === 'grant') {
    await deps.documents.set(AUTHZ_COLLECTIONS.humanPermissions, documentId, {
      human_subject: humanSubject, capability_id: capabilityId, granted_at: changedAt,
    });
  } else {
    await deps.documents.delete(AUTHZ_COLLECTIONS.humanPermissions, documentId);
  }
  await deps.publish({
    human_subject: humanSubject, capability_id: capabilityId, action: action as PermSetAction, changed_at: changedAt,
  });
  return 0;
}

/**
 * The command runs with the seed Job's data scope: `human_permissions` is the seed's
 * collection to write (00b §3), and the Authorization Platform may only read it.
 */
export function createPermSetDeps(env: NodeJS.ProcessEnv = process.env): PermSetDeps {
  const firestore = getFirestore({
    signer: 'local', vertex: 'fake',
    pubsub: env.PUBSUB_MODE === 'gcp' ? 'gcp' : 'inproc',
    store: env.STORE_MODE === 'emulator' ? 'emulator' : 'gcp',
  }, env);
  return {
    documents: createFirestoreDocumentStore(firestore, 'seed'),
    now: () => Date.now(),
    publish: async (message) => {
      if (env.PUBSUB_MODE !== 'gcp') {
        memoryQueue.push(message);
        return;
      }
      const { PubSub } = await import('@google-cloud/pubsub');
      await new PubSub().topic(PERMISSION_CHANGE_TOPIC).publishMessage({ json: message });
    },
  };
}
