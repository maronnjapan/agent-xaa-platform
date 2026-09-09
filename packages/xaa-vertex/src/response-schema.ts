/**
 * The ways a JSON Schema can be legal and still describe nothing to Vertex.
 *
 * `responseSchema` is an OpenAPI 3.0 subset, and an `object` there *is* its
 * `properties` map: there is no `additionalProperties: true`, no `patternProperties`
 * and no free-form value type. A schema that leaves `properties` off is accepted, and
 * the model then has no field it is permitted to emit — so the value comes back as `{}`
 * every time, for every prompt.
 *
 * That failure is invisible from the outside. The answer validates against the JSON
 * Schema the caller wrote (an empty object satisfies a bare `type: 'object'`), so
 * `generateJson` returns it rather than `null`, and the caller reads a well-formed
 * answer with nothing in it. The agent's reasoning loop shipped this way: every step
 * asked for a `tool_call`, received `{}`, and recorded `invalid_tool_call` against a
 * tool id of `unknown`.
 *
 * Hence a function rather than a comment. A response schema is a contract with a model
 * nobody can run in a unit test, and this is the part of that contract which can be
 * checked without one.
 */
export function vertexResponseSchemaProblems(schema: object, path = '$'): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => (item && typeof item === 'object'
      ? vertexResponseSchemaProblems(item as object, `${path}[${index}]`)
      : []));
  }

  const node = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (node.type === 'object') {
    const properties = node.properties;
    if (typeof properties !== 'object' || properties === null || Object.keys(properties).length === 0) {
      problems.push(`${path}: an object with no properties can only ever be answered as {}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') problems.push(...vertexResponseSchemaProblems(value as object, `${path}.${key}`));
  }
  return problems;
}
