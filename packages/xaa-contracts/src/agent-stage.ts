export const ACTIVITY_PHASES = ['work_definition', 'authorization', 'provisioning', 'tool_call', 'security', 'lifecycle', 'completed'] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];
export const AGENT_STAGES = ['define_work', 'decide_permission', 'map_to_tools', 'create_identity', 'access_resource', 'autonomous_run', 'monitor', 'destroy'] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

export const stageToPhase: Record<AgentStage, ActivityPhase> = {
  define_work: 'work_definition', decide_permission: 'authorization', map_to_tools: 'authorization', create_identity: 'provisioning',
  access_resource: 'tool_call', autonomous_run: 'tool_call', monitor: 'security', destroy: 'lifecycle',
};

export const stageToOwnerApp: Record<AgentStage, string[]> = {
  define_work: ['automation'], decide_permission: ['authorization'], map_to_tools: ['authorization'], create_identity: ['provisioner', 'agent-op'],
  access_resource: ['provisioner', 'agent-op'], autonomous_run: ['runtime'], monitor: ['security'], destroy: ['lifecycle'],
};

export const stageToAgentStatus: Record<AgentStage, string> = {
  define_work: 'CREATED', decide_permission: 'CREATED', map_to_tools: 'PROVISIONING', create_identity: 'PROVISIONING',
  access_resource: 'ACTIVE', autonomous_run: 'ACTIVE', monitor: 'ACTIVE', destroy: 'DESTROYED',
};
