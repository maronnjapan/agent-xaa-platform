import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanCommittedTasks } from '../src/tasks.js';

async function reviewRoot(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-import-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, '.review', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  return root;
}

const committed = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: '請求書の様式を確認する', detail: '', kind: 'action', priority: 'now',
  status: 'open', source: 'ai', quote: '', owner: '',
  plan: { commitment: 'committed', due: '', note: '', decidedAt: null },
  ...over,
});

describe('scanning what a reviewer committed to', () => {
  it('reads one task per document, named by where its file sits', async () => {
    const root = await reviewRoot({ 'docs/plan.md.tasks.json': { targetFile: 'docs/plan.md', tasks: [committed()] } });
    const scan = await scanCommittedTasks(root);
    expect(scan.documents).toEqual([{
      documentPath: 'docs/plan.md',
      tasks: [{ id: 't1', title: '請求書の様式を確認する', detail: '', priority: 'now', owner: '', quote: '', knowledge: '', due: '' }],
    }]);
  });

  it('names the document from the file path, not from the field inside it', async () => {
    const root = await reviewRoot({ 'a/b.md.tasks.json': { targetFile: 'somewhere/else.md', tasks: [committed()] } });
    const [document] = (await scanCommittedTasks(root)).documents;
    expect(document?.documentPath).toBe('a/b.md');
  });

  it('leaves out tasks nobody committed to, and ones already finished', async () => {
    const root = await reviewRoot({
      'plan.md.tasks.json': {
        tasks: [
          committed({ id: 'keep' }),
          { ...committed({ id: 'undecided' }), plan: { commitment: 'undecided' } },
          committed({ id: 'done', status: 'done' }),
          committed({ id: 'dismissed', status: 'dismissed' }),
          committed({ id: 'untitled', title: '' }),
        ],
      },
    });
    const [document] = (await scanCommittedTasks(root)).documents;
    expect(document?.tasks.map((task) => task.id)).toEqual(['keep']);
  });

  it('carries the quote, the owner and the reviewer knowledge, and the due date from the plan', async () => {
    const root = await reviewRoot({
      'plan.md.tasks.json': {
        tasks: [committed({
          detail: '様式は経理に聞く', quote: '請求書の様式が古い', owner: '田中',
          reference: { knowledge: '前回の改訂は2024年', files: ['plan.md'] },
          plan: { commitment: 'committed', due: '2026-09-30', note: '自分のメモ' },
        })],
      },
    });
    const [task] = (await scanCommittedTasks(root)).documents[0]!.tasks;
    expect(task).toMatchObject({
      detail: '様式は経理に聞く', quote: '請求書の様式が古い', owner: '田中',
      knowledge: '前回の改訂は2024年', due: '2026-09-30',
    });
  });

  it('reports a task file it cannot parse instead of passing over it', async () => {
    const root = await reviewRoot({ 'broken.md.tasks.json': '{ not json', 'plan.md.tasks.json': { tasks: [committed()] } });
    const scan = await scanCommittedTasks(root);
    expect(scan.unreadable).toEqual(['.review/broken.md.tasks.json']);
    expect(scan.documents).toHaveLength(1);
  });

  it('finds nothing, and complains about nothing, where no review has happened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-import-'));
    await expect(scanCommittedTasks(root)).resolves.toEqual({ documents: [], unreadable: [] });
  });
});
