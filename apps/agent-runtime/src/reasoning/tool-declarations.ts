import type { ToolManifest } from '@xaa/contracts';

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * What the model is told it can do — exactly the manifest, one declaration per tool.
 *
 * REQ-04-024 forbids a general-purpose escape hatch, and the way to guarantee one is
 * not present is to build the list by mapping rather than by composing: there is no
 * place here to append a helper, and no name in this file that is not a tool id.
 * A model that cannot see a generic HTTP tool cannot ask for one.
 */
export function buildToolDeclarations(manifest: ToolManifest): ToolDeclaration[] {
  return manifest.tools.map((tool) => ({
    name: tool.tool_id,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
