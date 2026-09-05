import { randomUUID } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';
import { assertWorkDefinition, type WorkDefinition } from './model.js';

export interface WorkDefinitionStore {
  create(input: Omit<WorkDefinition, 'work_definition_id' | 'created_at' | 'updated_at' | 'status'>, now?: number): Promise<WorkDefinition>;
  find(id: string): Promise<WorkDefinition | undefined>;
  /** Everything one person has written, newest first. */
  listByHuman(humanSubject: string): Promise<WorkDefinition[]>;
  save(definition: WorkDefinition): Promise<void>;
}

/**
 * A row this app wrote, told apart from one that only shares the collection.
 *
 * `work_definitions` is one collection for the platform (00b §3), and the access matrix
 * grants it to the Authorization Platform as well, which writes its own Work Definition
 * there: the structured one it derives, carrying `target_resources` and `constraints`
 * and no `status`. Both rows name the same person, so a query by `human_subject` returns
 * both, and rendering the other shape as a draft crashed the home screen on
 * `user_confirmations.map` — a 500 on the page a person lands on after logging in.
 *
 * The whole schema is the discriminator rather than a probe for one missing field,
 * because it is already what `create` and `save` hold this app's rows to. "A row this
 * app could have written" and "a row this app can render" then stay one statement, and a
 * field added to either shape later cannot make them drift apart.
 */
function isOwnDefinition(value: unknown): value is WorkDefinition {
  try {
    assertWorkDefinition(value);
    return true;
  } catch {
    return false;
  }
}

export function createWorkDefinitionStore(documents: DocumentStore): WorkDefinitionStore {
  return {
    async create(input, now = Date.now()) {
      const timestamp = new Date(now).toISOString();
      const definition: WorkDefinition = {
        work_definition_id: `wd_${randomUUID()}`,
        status: 'DRAFT',
        ...input,
        created_at: timestamp,
        updated_at: timestamp,
      };
      assertWorkDefinition(definition);
      await documents.set('work_definitions', definition.work_definition_id, definition as unknown as Record<string, unknown>);
      return definition;
    },
    /**
     * An id that belongs to the other writer answers the same as an id that belongs to
     * nobody. The routes above turn `undefined` into 404, which is what this app should
     * say about a work definition it does not have — rather than reading the row and
     * failing later, inside `save`, on a shape it was never able to write.
     */
    async find(id) {
      const found = await documents.get<WorkDefinition>('work_definitions', id);
      return isOwnDefinition(found) ? found : undefined;
    },
    /**
     * The subject is the caller's own, and the rows are filtered by it again on the way
     * out. The query already scopes the read; the second check costs nothing and means a
     * later change to the query cannot widen what a screen shows (RULE-56).
     */
    async listByHuman(humanSubject) {
      const rows = await documents.queryEqual<WorkDefinition>('work_definitions', [['human_subject', humanSubject]]);
      return rows
        .map((row) => row.data)
        .filter(isOwnDefinition)
        .filter((definition) => definition.human_subject === humanSubject)
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
    },
    /**
     * A whole-document write. `arrayUnion` would reorder `operations` into a set, and
     * the order is the sequence of steps a person read and agreed to.
     */
    async save(definition) {
      assertWorkDefinition(definition);
      await documents.set('work_definitions', definition.work_definition_id, definition as unknown as Record<string, unknown>);
    },
  };
}
