/**
 * Every model this platform can be pointed at except the one GCP runs.
 *
 * `@xaa/vertex` is the deployed path and stays exactly that: Vertex, the fake, and the
 * `generateJson` contract the four applications call. This package is the other side of
 * that contract — a LangChain-backed client that reaches Anthropic, OpenAI and anything
 * that speaks either API, plus a coding agent already installed on the machine — and
 * nothing in an image depends on it. The local runner builds a client from the
 * environment and installs it with `setDefaultModelClient`, so the applications ask the
 * same `generateJson` and never learn which model answered.
 */
export { createCliClient, type CliClientOptions, type CliPreset } from './cli-client.js';
export { extractJson, jsonOnlyPrompt, validateAnswer } from './json-answer.js';
export {
  createLangChainClient, isLangChainProvider, LANGCHAIN_PROVIDER_NAMES, LANGCHAIN_PROVIDERS,
  type ChatModel, type ChatModelRequest, type LangChainClientOptions,
  type LangChainProvider, type LangChainProviderDefinition,
} from './langchain-client.js';
export {
  createModelClient, ModelConfigurationError, readModelOptions,
  type ModelClientOptions, type ModelProvider,
} from './provider.js';
