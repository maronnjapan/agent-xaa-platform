import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
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
