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
    async find(id) {
      return documents.get<WorkDefinition>('work_definitions', id);
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
