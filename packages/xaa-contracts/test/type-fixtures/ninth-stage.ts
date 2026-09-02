import { stageToPhase, type AgentStage } from '../../src/agent-stage.js';

/**
 * Deliberately uncompilable. docs 01 §1 has eight stages, and the three maps in
 * `agent-stage.ts` are `Record<AgentStage, …>` so that adding a ninth is a compile
 * error rather than a map with a missing entry that reads as `undefined` at runtime.
 *
 * `agent-stage.spec.ts` runs `tsc --noEmit -p` over this directory and fails if it
 * ever starts succeeding.
 */
const ninth: AgentStage = 'archive';

export const phaseOfNinth = stageToPhase[ninth];
