import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { GenerateJsonParams, VertexClient } from '@xaa/vertex';
import { extractJson, jsonOnlyPrompt, validateAnswer } from './json-answer.js';

/**
 * A chat model, in the little of one this package uses.
 *
 * LangChain's `BaseChatModel` satisfies this structurally, which is the point: the
 * platform asks one question and reads one answer, and nothing here depends on the rest
 * of a class that also streams, batches, caches and traces.
 */
export interface ChatModel {
  invoke(prompt: string): Promise<{ content: unknown }>;
  withStructuredOutput(schema: object, config?: { name?: string }): { invoke(prompt: string): Promise<unknown> };
}

/** One question's worth of model configuration. */
export interface ChatModelRequest {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
  temperature: number;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface LangChainProviderDefinition {
  /** The variable a deployment puts the credential in. */
  apiKeyEnv: string;
  /** The variable that points the provider somewhere other than its own endpoint. */
  baseUrlEnv: string;
  create(request: ChatModelRequest): ChatModel;
}

/**
 * Every model this platform can call that is neither Vertex nor a command on the
 * machine, as one table.
 *
 * Adding a provider is an entry here and a dependency in `package.json`: the client
 * below, `readModelOptions` and the four applications learn no new name. That is what
 * LangChain is in the tree for — each of these used to be a hand-written client that had
 * to be told again how to carry a schema, how to find the answer in the reply, and how
 * to fail — and it is why the provider, not this file, decides what a schema-constrained
 * request looks like on the wire.
 *
 * `openai` covers every OpenAI-compatible server as well as OpenAI itself, because that
 * API is what Ollama, vLLM, LM Studio and the gateways in front of them implement.
 * `OPENAI_BASE_URL` is then the base URL as the OpenAI SDK reads it, version path
 * included: `http://127.0.0.1:11434/v1`, not `http://127.0.0.1:11434`.
 */
export const LANGCHAIN_PROVIDERS = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    create: (request: ChatModelRequest): ChatModel => new ChatAnthropic({
      model: request.model,
      apiKey: request.apiKey,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      ...(request.baseUrl ? { anthropicApiUrl: request.baseUrl } : {}),
      ...(request.fetchImpl ? { clientOptions: { fetch: request.fetchImpl } } : {}),
    }),
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    create: (request: ChatModelRequest): ChatModel => new ChatOpenAI({
      model: request.model,
      apiKey: request.apiKey,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      configuration: {
        ...(request.baseUrl ? { baseURL: request.baseUrl } : {}),
        ...(request.fetchImpl ? { fetch: request.fetchImpl } : {}),
      },
    }),
  },
} as const satisfies Record<string, LangChainProviderDefinition>;

/** The provider names `MODEL_PROVIDER` accepts for the generic client. */
export type LangChainProvider = keyof typeof LANGCHAIN_PROVIDERS;

export const LANGCHAIN_PROVIDER_NAMES = Object.keys(LANGCHAIN_PROVIDERS) as readonly LangChainProvider[];

export function isLangChainProvider(value: string): value is LangChainProvider {
  return Object.hasOwn(LANGCHAIN_PROVIDERS, value);
}

export interface LangChainClientOptions {
  provider: LangChainProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The name the schema-constrained answer is given; it never reaches the caller. */
const ANSWER_NAME = 'answer';

/** An `AIMessage`'s content, which is a string for some providers and blocks for others. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : (block as { text?: unknown }).text))
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

/**
 * Any model LangChain can reach, answering with the caller's schema.
 *
 * `withStructuredOutput` is the one channel that carries a schema, and each provider
 * fills it with whatever its own API has: Anthropic forces a tool call whose
 * `input_schema` is the schema, OpenAI sets `response_format: json_schema`. Those are
 * the same two requests this repository used to build by hand, now chosen by the
 * provider package — so a provider that gains a better channel gains it here without an
 * edit, and one that has none still answers.
 *
 * A schema whose root is not an object has no such channel anywhere: neither a tool
 * input nor a JSON Schema response format may be a bare array or string. Those fall back
 * to the schema in the prompt and `extractJson`, exactly as a command-line agent does.
 *
 * Whatever comes back is validated against the caller's schema here, so the answer is
 * the value the caller asked for or it is `null` — the same two outcomes every other
 * provider in this repository produces.
 */
export function createLangChainClient(options: LangChainClientOptions): VertexClient {
  const create = LANGCHAIN_PROVIDERS[options.provider].create;

  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      // The model is built per question because `maxOutputTokens` and `temperature` are
      // the caller's, not the deployment's: LangChain carries both on the model object,
      // so one shared instance would answer the next caller with the last caller's
      // limits. Building one opens no connection.
      const chat = create({
        model: options.model,
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        maxTokens: params.maxOutputTokens,
        temperature: params.temperature,
      });
      try {
        if ((params.schema as { type?: unknown }).type === 'object') {
          const value = await chat.withStructuredOutput(params.schema, { name: ANSWER_NAME }).invoke(params.prompt);
          return validateAnswer<T>(value, params.schema);
        }
        const reply = await chat.invoke(jsonOnlyPrompt(params));
        return validateAnswer<T>(extractJson(textOf(reply.content)), params.schema);
      } catch {
        return null;
      }
    },
  };
}
