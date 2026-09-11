import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AutomationAppRefusal, type AutomationApp } from '../src/client.js';
import { runImport, type ImportDeps } from '../src/import.js';
import type { TodoRequest } from '../src/todo.js';

const URL_ = 'http://127.0.0.1:8080';
const ENV = { AUTOMATION_APP_URL: URL_, AUTOMATION_APP_ACCESS_TOKEN: 'token' } as NodeJS.ProcessEnv;

const committed = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: '請求書の様式を確認する', priority: 'high', status: 'open',
  plan: { commitment: 'committed' }, ...over,
});

async function reviewRoot(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-import-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, '.review', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  return root;
}

let out: string[];
let err: string[];
let sent: TodoRequest[];

function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  let next = 0;
  const app: AutomationApp = {
    async registerTodo(request) {
      sent.push(request);
      next += 1;
      return { work_definition_id: `wd-${next}` } as Awaited<ReturnType<AutomationApp['registerTodo']>>;
    },
  };
  return {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: ENV,
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    createApp: () => app,
    ...over,
  };
}

beforeEach(() => { out = []; err = []; sent = []; });

describe('registering what a reviewer committed to', () => {
  it('registers each task once and reports what it made', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { tasks: [committed()] } });
    expect(await runImport([root], deps())).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('請求書の様式を確認する');
    expect(out).toEqual([
      'registered docs/plan.md#t1 as wd-1: 請求書の様式を確認する',
      'registered 1, already registered 0',
    ]);
  });

  it('does not register the same task twice when run again', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { tasks: [committed()] } });
    await runImport([root], deps());
    sent = []; out = [];
    expect(await runImport([root], deps())).toBe(0);
    expect(sent).toEqual([]);
    expect(out).toEqual(['registered 0, already registered 1']);
  });

  it('registers again when pointed at a different Automation App', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { tasks: [committed()] } });
    await runImport([root], deps());
    sent = [];
    await runImport([root, '--url', 'http://127.0.0.1:9090'], deps());
    expect(sent).toHaveLength(1);
  });

  it('keeps its record beside the review files and writes nothing into them', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { tasks: [committed()] } });
    const before = await readFile(join(root, '.review/docs/plan.md.tasks.json'), 'utf8');
    await runImport([root], deps());
    expect(await readFile(join(root, '.review/docs/plan.md.tasks.json'), 'utf8')).toBe(before);
    const ledger = JSON.parse(await readFile(join(root, '.review/.automation-app-import.json'), 'utf8'));
    expect(ledger.entries['docs/plan.md#t1']).toEqual({
      work_definition_id: 'wd-1',
      automation_app_url: URL_,
      imported_at: '2026-09-07T00:00:00.000Z',
    });
  });

  it('carries on past a refused task and ends non-zero', async () => {
    const root = await reviewRoot({
      'a.md.tasks.json': { tasks: [committed({ id: 'bad' })] },
      'b.md.tasks.json': { tasks: [committed({ id: 'good' })] },
    });
    const refuseFirst: AutomationApp = {
      async registerTodo(request) {
        if (request.title.includes('だめ')) throw new AutomationAppRefusal('the access token is not valid any more', 401);
        sent.push(request);
        return { work_definition_id: 'wd-1' } as Awaited<ReturnType<AutomationApp['registerTodo']>>;
      },
    };
    await writeFile(
      join(root, '.review/a.md.tasks.json'),
      JSON.stringify({ tasks: [committed({ id: 'bad', title: 'だめな方' })] }),
      'utf8',
    );
    expect(await runImport([root], deps({ createApp: () => refuseFirst }))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(err).toEqual(['refused a.md#bad: the access token is not valid any more']);
    expect(out.at(-1)).toBe('registered 1, already registered 0, refused 1');
  });

  it('sends nothing on a dry run, and needs no token for one', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { tasks: [committed()] } });
    const code = await runImport([root, '--dry-run'], deps({ env: { AUTOMATION_APP_URL: URL_ } }));
    expect(code).toBe(0);
    expect(sent).toEqual([]);
    expect(out).toEqual([
      'would register docs/plan.md#t1: 請求書の様式を確認する',
      'would register 1, already registered 0',
    ]);
  });

  it('says what to set when the app or the token is missing', async () => {
    const root = await reviewRoot({});
    expect(await runImport([root], deps({ env: {} }))).toBe(1);
    expect(err[0]).toContain('AUTOMATION_APP_URL');
    err = [];
    expect(await runImport([root], deps({ env: { AUTOMATION_APP_URL: URL_ } }))).toBe(1);
    expect(err[0]).toContain('AUTOMATION_APP_ACCESS_TOKEN');
  });

  it('refuses arguments it does not understand, and prints the usage', async () => {
    expect(await runImport([], deps())).toBe(1);
    expect(err.at(-1)).toContain('usage: pnpm review:import');
    err = [];
    expect(await runImport(['/tmp', '--nope'], deps())).toBe(1);
    expect(err[0]).toBe('unknown option: --nope');
  });

  it('prints the usage for --help and stops', async () => {
    expect(await runImport(['--help'], deps())).toBe(0);
    expect(out[0]).toContain('Registration stops at the draft');
  });
});
