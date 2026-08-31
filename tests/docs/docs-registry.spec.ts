import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const run = (script: string, ...args: string[]) => execFileSync('node', [script, ...args], { cwd: root, encoding: 'utf8' });

async function readDoc(name: string): Promise<string> {
  return readFile(join(root, 'docs', name), 'utf8');
}

describe('the requirements index', () => {
  it('lists every requirement once, in ascending order', async () => {
    const rows = (await readDoc('requirements.md')).split('\n').filter((line) => /^\| REQ-\d{2}-\d{3} /.test(line));
    const ids = rows.map((row) => row.split('|')[1]!.trim());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('names only tasks that exist', () => {
    expect(() => run('scripts/check-requirements-index.mjs')).not.toThrow();
  });

  it('fails when a planned row names a task that does not', async () => {
    const original = await readDoc('requirements.md');
    const broken = original.replace(/\| T-[A-Z]+-\d{2} \| planned \|/, '| T-NOPE-99 | planned |');
    expect(broken).not.toBe(original);
    await writeTemporarily('docs/requirements.md', broken, () => {
      expect(() => run('scripts/check-requirements-index.mjs')).toThrow();
    });
  });
});

describe('the deviation registry', () => {
  it('has fifteen rows, DEV-01 to DEV-15 with no gaps', async () => {
    const rows = (await readDoc('deviations.md')).split('\n').filter((line) => /^\| \*\*DEV-/.test(line));
    expect(rows).toHaveLength(15);
  });

  it('marks DEV-07 withdrawn and leaves its other columns empty', async () => {
    const row = (await readDoc('deviations.md')).split('\n').find((line) => line.startsWith('| **DEV-07**'))!;
    expect(row).toContain('取り下げ');
    expect(row.split('|').slice(3, 6).map((cell) => cell.trim())).toEqual(['-', '-', '-']);
  });

  it('maps all seven items REQ-10-004 lists', async () => {
    const text = await readDoc('deviations.md');
    expect(text).toContain('## 2. REQ-10-004');
    for (const deviation of ['DEV-01', 'DEV-02', 'DEV-03', 'DEV-04', 'DEV-06', 'DEV-14']) {
      expect(text.split('## 2. REQ-10-004')[1]).toContain(deviation);
    }
    // The seventh, FULL_ISOLATION, is recorded as no deviation at all.
    expect(text.split('## 2. REQ-10-004')[1]).toContain('逸脱なし');
  });

  it('passes both the completeness and the strict check', () => {
    expect(() => run('scripts/check-deviations.mjs')).not.toThrow();
    expect(() => run('scripts/check-deviations.mjs', '--strict')).not.toThrow();
  });

  it('fails when a column is emptied', async () => {
    const original = await readDoc('deviations.md');
    const broken = original.replace(
      /\| ドラフト ID-JAG は DPoP を要求しない。RULE-06 はこれを必須にする \|/,
      '|  |',
    );
    expect(broken).not.toBe(original);
    await writeTemporarily('docs/deviations.md', broken, () => {
      expect(() => run('scripts/check-deviations.mjs')).toThrow();
    });
  });

  it('fails strict mode when a test name does not exist', async () => {
    const original = await readDoc('deviations.md');
    const broken = original.replace('rejects htm mismatch', 'a test nobody wrote');
    await writeTemporarily('docs/deviations.md', broken, () => {
      expect(() => run('scripts/check-deviations.mjs', '--strict')).toThrow();
    });
  });
});

describe('the rules registry', () => {
  it('holds sixty rules across nine categories with no gaps', async () => {
    const registry = JSON.parse(await readDoc('rules.json')) as {
      rules: Array<{ id: string; category: string; text: string; sources: unknown[] }>;
      categories: Array<{ id: string; title: string }>;
    };
    expect(registry.rules).toHaveLength(60);
    expect(registry.categories).toHaveLength(9);
    const ids = registry.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(60);
    for (let number = 1; number <= 60; number += 1) {
      expect(ids).toContain(`RULE-${String(number).padStart(2, '0')}`);
    }
    const categoryIds = new Set(registry.categories.map((category) => category.id));
    for (const rule of registry.rules) {
      expect(categoryIds.has(rule.category)).toBe(true);
      expect(rule.sources.length).toBeGreaterThan(0);
      expect(rule.text.trim()).not.toBe('');
    }
  });

  it('generates the markdown byte for byte', async () => {
    const before = await readDoc('10-design-rules.md');
    run('scripts/gen-design-rules.mjs');
    expect(await readDoc('10-design-rules.md')).toBe(before);
  });
});

describe('the traceability table', () => {
  it('has one row per rule, in the registry order', async () => {
    const registry = JSON.parse(await readDoc('rules.json')) as { rules: Array<{ id: string }> };
    const rows = (await readDoc('rule-traceability.md')).split('\n').filter((line) => /^\| RULE-\d{2} /.test(line));
    expect(rows).toHaveLength(60);
    expect(rows.map((row) => row.split('|')[1]!.trim())).toEqual(registry.rules.map((rule) => rule.id));
  });

  it('points every implemented row at a test file that exists', async () => {
    const rows = (await readDoc('rule-traceability.md')).split('\n').filter((line) => /^\| RULE-\d{2} /.test(line));
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim().replaceAll('`', ''));
      const [, id, , impl, test, state] = cells;
      expect(['実装', '未実装']).toContain(state);
      if (state === '未実装') {
        expect([impl, test]).toEqual(['-', '-']);
        continue;
      }
      for (const path of impl!.split(' / ')) await expectExists(path, id!);
      await expectExists(test!.split('::')[0]!, id!);
    }
  });

  it('notes the deviation on every rule the platform deliberately does not keep', async () => {
    const text = await readDoc('rule-traceability.md');
    for (const id of ['RULE-32', 'RULE-33', 'RULE-34', 'RULE-42', 'RULE-57']) {
      const row = text.split('\n').find((line) => line.startsWith(`| ${id} `))!;
      expect(row).toMatch(/DEV-\d{2}/);
    }
  });
});

describe('the glossary', () => {
  it('lists 26 terms and every name the platform uses', () => {
    expect(() => run('scripts/check-glossary.mjs')).not.toThrow();
    expect(() => run('scripts/check-glossary.mjs', '--strict')).not.toThrow();
  });

  it('records the eight capabilities, seven scopes and seven tool ids', async () => {
    const text = await readDoc('glossary.md');
    const section = text.split('## 2. 確定した命名')[1]!;
    const { CAPABILITIES, RESOURCE_SCOPES, TOOL_IDS } = await import('@xaa/contracts');
    for (const value of [...CAPABILITIES, ...RESOURCE_SCOPES]) expect(section).toContain(value);
    for (const value of TOOL_IDS.filter((tool) => tool.startsWith('internal.'))) expect(section).toContain(value);
    expect(CAPABILITIES).toHaveLength(8);
    expect(RESOURCE_SCOPES).toHaveLength(7);
  });
});

describe('cross references', () => {
  it('every link and anchor in docs resolves', () => {
    expect(() => run('scripts/check-docs-links.mjs')).not.toThrow();
  });
});

async function expectExists(path: string, id: string): Promise<void> {
  try {
    await access(join(root, path));
  } catch {
    throw new Error(`${id}: no such path ${path}`);
  }
}

/** Writes a broken copy, runs the assertion, and always puts the original back. */
async function writeTemporarily(relative: string, content: string, run: () => void): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const path = join(root, relative);
  const original = await readFile(path, 'utf8');
  await writeFile(path, content);
  try {
    run();
  } finally {
    await writeFile(path, original);
  }
}
