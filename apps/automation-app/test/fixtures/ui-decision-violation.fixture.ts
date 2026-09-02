// A deliberate violation, kept out of the directories the rule covers.
//
// RULE-54: the timeline shows what happened, it does not decide anything. The ESLint
// `no-restricted-imports` rule for `apps/automation-app/src/activity/**` and
// `apps/automation-app/src/ui/**` is what stops a renderer importing something that
// forms an opinion — a risk scorer, a policy engine, a detection module.
//
// Here, under `test/fixtures/`, the rule does not apply and `pnpm lint` stays green.
// Copied into `src/ui/` it is rejected, which is how `ui.spec.ts` confirms the rule
// still bites rather than trusting that it is still configured.
import { recalculateRiskScore } from './risk-scoring.js';

export const UI_DECISION_VIOLATION = recalculateRiskScore;
