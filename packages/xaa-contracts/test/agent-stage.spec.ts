import { describe, expect, it } from 'vitest';
import { ACTIVITY_PHASES, AGENT_STAGES, stageToAgentStatus, stageToOwnerApp, stageToPhase } from '../src/index.js';

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
});
