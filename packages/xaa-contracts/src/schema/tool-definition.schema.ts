import { CAPABILITIES, RESOURCE_SCOPES, TOOL_IDS } from '../identifiers.js';

export const toolDefinitionSchema = {
  $id: 'tool-definition',
  type: 'object',
  additionalProperties: false,
  required: ['tool_id', 'capability_id', 'connector_id', 'api'],
  properties: {
    tool_id: { enum: TOOL_IDS },
    capability_id: { enum: CAPABILITIES },
    connector_id: { type: 'string', minLength: 1 },
    api: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path', 'scope'],
      properties: { method: { enum: ['GET', 'POST', 'PATCH'] }, path: { type: 'string', pattern: '^/' }, scope: { enum: RESOURCE_SCOPES } },
    },
  },
} as const;
