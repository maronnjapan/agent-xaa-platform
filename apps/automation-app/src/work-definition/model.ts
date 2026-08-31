import { compile } from '@xaa/contracts';
import { workDefinitionSchema, WORK_DEFINITION_FIELDS } from '../schemas/index.js';

export type WorkDefinitionStatus = 'DRAFT' | 'CONFIRMED';

export interface WorkDefinition {
  work_definition_id: string;
  human_subject: string;
  status: WorkDefinitionStatus;
  purpose: string;
  description: string;
  operations: string[];
  user_confirmations: string[];
  safety_notes: string[];
  requested_lifetime_hours: number;
  created_at: string;
  updated_at: string;
}

export { WORK_DEFINITION_FIELDS };

export const assertWorkDefinition: (value: unknown) => asserts value is WorkDefinition =
  compile<WorkDefinition>(workDefinitionSchema);

/**
 * Two states, and only a person moves between them.
 *
 * RULE-08: the Automation Design AI proposes, it does not conclude. There is no
 * `CONFIRMING`, no timer that promotes a draft and no branch that reads a model's
 * "I have confirmed this" as confirmation — the transition happens in exactly one
 * route handler, called by a click.
 */
export function confirm(definition: WorkDefinition, now: string): WorkDefinition {
  return { ...definition, status: 'CONFIRMED', updated_at: now };
}
