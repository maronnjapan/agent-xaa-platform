export interface RateRange { min: number; max: number }

export interface AgentBaseline {
  effective_capabilities: string[];
  expected_tools: string[];
  expected_resources: string[];
  expected_rate: { id_jag: RateRange; api_request: RateRange };
  lifetime: string;
  current_session_behavior: Record<string, number>;
}

export const BASELINE_ELEMENTS = [
  'effective_capabilities', 'expected_tools', 'expected_resources',
  'expected_rate', 'lifetime', 'current_session_behavior',
] as const;
