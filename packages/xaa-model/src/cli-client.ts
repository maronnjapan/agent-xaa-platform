import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelConfigurationError } from './errors.js';
import { extractJson, jsonOnlyPrompt, validateAnswer } from './json-answer.js';
import type { GenerateJsonParams, VertexClient } from '@xaa/vertex';

/** The command-line agents this repository knows how to invoke without configuration. */
export type CliPreset = 'claude-code' | 'codex' | 'custom';

export interface CliClientOptions {
  preset: CliPreset;
  /** The model name passed on to the agent; omitted when the caller names none. */
  model?: string;
  /** Required for `custom`; overrides the preset's own binary otherwise. */
  command?: string;
  /** Replaces the preset's arguments outright when given. */
  args?: readonly string[];
  /** Where the agent runs. Defaults to a temporary directory, never the repository. */
  cwd?: string;
  timeoutMs?: number;
  /** Test seam, so a spec can exercise the parsing without a binary on PATH. */
  run?: (input: { command: string; args: readonly string[]; prompt: string; cwd: string; timeoutMs: number }) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * How each known agent is asked one question and told to answer on stdout.
 *
 * The prompt goes in on stdin rather than in an argument: these prompts carry a whole
 * tool manifest and a schema, and an argument list has a length ceiling that a task
 * description will eventually cross. Nothing is ever passed through a shell, so a
 * prompt cannot become a command.
 */
function presetArgv(preset: Exclude<CliPreset, 'custom'>, model: string | undefined): { command: string; args: string[] } {
  if (preset === 'claude-code') {
    return {
      command: 'claude',
      args: ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])],
    };
  }
  return {
    command: 'codex',
    // `-` is the prompt on stdin; `--skip-git-repo-check` keeps the agent from
    // refusing to start in the scratch directory it is given below.
    args: ['exec', '--skip-git-repo-check', ...(model ? ['--model', model] : []), '-'],
  };
}

/**
 * Whether a command is actually there to be spawned.
 *
 * `spawn` does not fail until the question is asked, and the answer to a question that
 * could not be asked is `null` — which is also the answer to a question the agent
 * answered badly. So `MODEL_CLI=codex` on a machine without Codex would look like a
 * platform whose model is installed and unhelpful: every Work Definition would come back
 * without an Agent Definition, and nothing would say why. Resolving the command the way
 * `spawn` will resolve it turns that into one sentence at startup.
 *
 * A name containing a separator is a path and is checked as one; anything else is looked
 * for along `PATH`, executable bit and all, because that is what `spawn` does with it.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A directory on `PATH` can carry the execute bit and share the command's name, and
  // `spawn` would still fail on it, so presence alone is not the question.
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch { return false; }
  };
  if (command.includes('/') || isAbsolute(command)) return executable(command) ? command : undefined;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function runProcess(input: { command: string; args: readonly string[]; prompt: string; cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('model command timed out')); }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model command exited ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.end(input.prompt, 'utf8');
  });
}

/**
 * A locally installed coding agent — Claude Code, Codex, or any command that reads a
 * prompt on stdin — used as the platform's model.
 *
 * These agents have no response-schema channel, so the schema travels in the prompt and
 * the answer is scanned out of whatever the agent wrote. The result is validated
 * against the same schema as every other provider's, so a chatty agent produces `null`
 * rather than a shape the caller was not promised.
 *
 * It runs in a temporary directory, never in the repository: a coding agent invoked
 * here is being asked one question, and giving it the checkout as a working tree would
 * let an answer become an edit.
 *
 * The one thing it will not answer `null` to is a command that is not installed. That is
 * a configuration the platform cannot run at all rather than a question that went badly,
 * so it is raised here, before anything is asked.
 */
export function createCliClient(options: CliClientOptions): VertexClient {
  const resolved = options.preset === 'custom'
    ? { command: options.command ?? '', args: [] as string[] }
    : presetArgv(options.preset, options.model);
  const command = options.command ?? resolved.command;
  const args = options.args ?? resolved.args;
  const cwd = options.cwd ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.run ?? runProcess;
  // Only when this really will spawn: a caller that handed in `run` has no binary to find.
  if (options.run === undefined && command !== '' && findOnPath(command) === undefined) {
    throw new ModelConfigurationError(
      `MODEL_CLI=${options.preset} needs the \`${command}\` command, and it is not on PATH. `
      + 'Install it, or choose a provider that needs no command (MODEL_PROVIDER=anthropic or openai with an API key).',
    );
  }

  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      if (!command) return null;
      try {
        const stdout = await run({ command, args, prompt: jsonOnlyPrompt(params), cwd, timeoutMs });
        return validateAnswer<T>(extractJson(stdout), params.schema);
      } catch {
        return null;
      }
    },
  };
}
