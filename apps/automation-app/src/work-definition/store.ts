import { randomUUID } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';
import { assertWorkDefinition, type WorkDefinition } from './model.js';

export interface WorkDefinitionStore {
  create(input: Omit<WorkDefinition, 'work_definition_id' | 'created_at' | 'updated_at' | 'status'>, now?: number): Promise<WorkDefinition>;
  find(id: string): Promise<WorkDefinition | undefined>;
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
     * A whole-document write. `arrayUnion` would reorder `operations` into a set, and
     * the order is the sequence of steps a person read and agreed to.
     */
    async save(definition) {
      assertWorkDefinition(definition);
      await documents.set('work_definitions', definition.work_definition_id, definition as unknown as Record<string, unknown>);
    },
  };
}
