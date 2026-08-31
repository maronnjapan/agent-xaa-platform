// A deliberate violation, kept out of the lint target set.
//
// If this file were placed under apps/automation-app/src/ui, the `no-restricted-imports`
// rule added for that directory would reject it — which is the point: the rule is what
// stops a renderer from importing something that makes decisions. Moving this file
// there is the way to confirm the rule still bites.
//
//   import { recalculateRiskScore } from '../../../security-detection/risk-scoring.js';
//
export const UI_DECISION_VIOLATION = "import from '*risk-scoring*' inside src/ui";
