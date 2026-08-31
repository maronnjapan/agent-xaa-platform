import type { RuntimeInstruction, RuntimeStore } from '../store/runtime-store.js';

export interface AppliedInstruction {
  role: 'user';
  source: 'instruction';
  instruction_id: string;
  body: string;
}

/**
 * Read the unapplied instructions and mark them applied, in one transaction.
 *
 * REQ-02-025 puts this at the head of every reasoning step, which means it runs many
 * times per execution and may run concurrently with another execution of the same
 * agent. Reading and stamping separately would let the same instruction be picked up
 * twice — once by each reader — and the model would act on it twice. The store does
 * both inside `runTransaction`, so the second reader sees an empty set.
 */
export async function readPendingInstructions(
  store: RuntimeStore,
  now: string = new Date().toISOString(),
): Promise<AppliedInstruction[]> {
  const pending: RuntimeInstruction[] = await store.readPendingInstructions(now);
  return pending.map((instruction) => ({
    role: 'user',
    source: 'instruction',
    instruction_id: instruction.instruction_id,
    body: instruction.body,
  }));
}
