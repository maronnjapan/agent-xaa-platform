import type { AiOutput, ResponseState } from '../ai/output.js';
import type { SecurityFinding } from '../correlate/finding.js';

/** Where the recommendation came from: the model's answer, or the risk level alone. */
export const ANALYSIS_SOURCES = ['model', 'fallback'] as const;
export type AnalysisSource = (typeof ANALYSIS_SOURCES)[number];

/**
 * A finding as it is kept, which is the finding plus what the Security AI made of it.
 *
 * The recommendation alone used to be stored, and it is the one part of the model's
 * answer that needs no reading: `QUARANTINED` says what will happen and says nothing
 * about why. The other three aspects are the why, and a person asked to approve a
 * quarantine — or trying to understand one that already happened — has no other source
 * for it. They are kept in the model's own words, and the screen that shows them writes
 * no sentence of its own (RULE-54).
 */
export interface StoredFinding extends SecurityFinding {
  recommended_response?: ResponseState;
  confidence?: number;
  /** The four aspects of docs 09 §5.6. Absent when the model gave nothing usable. */
  analysis?: AiOutput;
  analysis_source?: AnalysisSource;
  analyzed_at?: string;
  /** Written by the review route when a person decided; never by the pipeline. */
  reviewer?: string;
}
