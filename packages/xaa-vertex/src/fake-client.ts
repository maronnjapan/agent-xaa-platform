import AjvModule from 'ajv';
import type { GenerateJsonParams, VertexClient } from './index.js';

const Ajv = (AjvModule as unknown as { default?: new (options?: object) => import('ajv').default }).default ?? AjvModule as unknown as new (options?: object) => import('ajv').default;
export type FakeResponder = (params: GenerateJsonParams) => unknown | Promise<unknown>;

export function createFakeClient(responder: FakeResponder = () => null): VertexClient {
  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      const value = await responder(params);
      const validate = new Ajv({ strict: false }).compile(params.schema);
      return validate(value) ? value as T : null;
    },
  };
}
