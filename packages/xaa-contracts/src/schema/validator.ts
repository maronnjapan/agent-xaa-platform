import AjvModule, { type AnySchema, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const Ajv = (AjvModule as unknown as { default?: new (options?: object) => import('ajv').default }).default ?? AjvModule as unknown as new (options?: object) => import('ajv').default;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const ajv = new Ajv({ strict: true, allErrors: false, removeAdditional: false });
(addFormats as unknown as (instance: import('ajv').default, formats?: string[]) => void)(ajv, ['date-time', 'uri', 'uuid']);

export class SchemaValidationError extends Error {
  constructor(public readonly schemaId: string, public readonly instancePath: string) {
    super('schema validation failed');
    this.name = 'SchemaValidationError';
  }
}

export function compile<T = unknown>(schema: AnySchema): (data: unknown) => asserts data is T {
  // A schema embedded inside another (xaa-static-config inside agent-registration) is
  // registered by $id the first time its parent compiles. Reuse that registration
  // instead of letting Ajv reject the duplicate $id.
  const schemaId = (schema as Record<string, unknown>).$id;
  const registered = typeof schemaId === 'string' ? ajv.getSchema<T>(schemaId) : undefined;
  const validate: ValidateFunction<T> = registered ?? ajv.compile(schema);
  return (data: unknown): asserts data is T => {
    if (!validate(data)) throw new SchemaValidationError(String((schema as Record<string, unknown>).$id ?? 'anonymous'), validate.errors?.[0]?.instancePath ?? '');
  };
}
