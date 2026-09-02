import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ACTIVITY_EVENT_PHASES, ACTIVITY_PHASES, AGENT_STAGES,
  stageToAgentStatus, stageToOwnerApp, stageToPhase,
} from '../src/index.js';

describe('agent stages', () => {
  it('covers all 8 stages', () => {
    expect(AGENT_STAGES).toHaveLength(8);
    for (const stage of AGENT_STAGES) {
      expect(stageToPhase[stage]).toBeTruthy();
      expect(stageToOwnerApp[stage].length).toBeGreaterThan(0);
      expect(stageToAgentStatus[stage]).toBeTruthy();
      expect(ACTIVITY_PHASES).toContain(stageToPhase[stage]);
    }
  });

  /**
   * The range of the map, not its domain. `Record<AgentStage, ActivityPhase>` is the
   * compile-time half — a stage mapped to a word that is not a phase does not build —
   * and the loop below is the runtime half, which is what catches a phase list that
   * was shortened after the map was written.
   */
  it('maps every stage into the seven phases', () => {
    expect(ACTIVITY_PHASES).toHaveLength(7);
    expect(ACTIVITY_EVENT_PHASES).toHaveLength(7);
    const range = new Set(AGENT_STAGES.map((stage) => stageToPhase[stage]));
    for (const phase of range) {
      expect(ACTIVITY_PHASES).toContain(phase);
      // Every stage also lands on a phase an Activity Event may carry, so a stage can
      // always be published as one.
      expect(ACTIVITY_EVENT_PHASES as readonly string[]).toContain(phase);
    }
    expect(range.size).toBeLessThanOrEqual(ACTIVITY_PHASES.length);
  });

  /**
   * A ninth stage has to be a compile error: the three maps are total over `AgentStage`,
   * and a stage that slipped past the type would read back as `undefined` in whichever
   * of them its author forgot.
   */
  it('fails to compile a ninth stage', async () => {
    const project = new URL('./type-fixtures/tsconfig.json', import.meta.url).pathname;
    const failure = await promisify(execFile)('npx', ['tsc', '--noEmit', '-p', project], {
      cwd: new URL('../../..', import.meta.url).pathname,
    }).then(() => null, (error: { code?: number; stdout?: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).not.toBe(0);
    expect(failure!.stdout).toContain('ninth-stage.ts');
  }, 60_000);
});
