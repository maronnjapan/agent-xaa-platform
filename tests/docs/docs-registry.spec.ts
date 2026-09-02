import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@xaa/contracts';
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
    const broken = original.replace('rejects htu mismatch', 'a test nobody wrote');
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

  /**
   * The eight rules the confirmed decisions changed, and the record of what they said
   * before. A revision without its reason is a rule nobody can argue with later.
   */
  it('keeps the revised rules and their reasons together', async () => {
    const registry = JSON.parse(await readDoc('rules.json')) as {
      rules: Array<{ id: string; text: string; revised_from?: string; revised_reason?: string }>;
    };
    const revised = registry.rules.filter((rule) => rule.revised_from !== undefined);
    expect(revised.map((rule) => rule.id).sort()).toEqual([
      'RULE-06', 'RULE-34', 'RULE-42', 'RULE-44', 'RULE-47', 'RULE-49', 'RULE-53', 'RULE-57',
    ]);
    for (const rule of revised) {
      expect(rule.revised_reason?.trim()).toBeTruthy();
      // A revision that kept the same words is a note, not a revision.
      expect(rule.revised_from).not.toBe(rule.text);
    }
    for (const rule of registry.rules) {
      if (rule.revised_from === undefined) expect(rule.revised_reason).toBeUndefined();
    }
  });

  it('leaves no retired project layout in the generated markdown', async () => {
    const generated = await readDoc('10-design-rules.md');
    for (const retired of ['agent-security-prod', 'パスでデプロイを分ける']) {
      expect(generated).not.toContain(retired);
    }
  });

  /**
   * A generator nobody notices has stopped matching its source is worse than no
   * generator: the Markdown keeps being read as if it were current.
   */
  it('notices when the generated markdown no longer matches the registry', async () => {
    const registry = await readDoc('rules.json');
    const changed = registry.replace('"category": "identity"', '"category": "identity", "text_note": "x"');
    expect(changed).not.toBe(registry);
    const before = await readDoc('10-design-rules.md');
    await writeTemporarily('docs/10-design-rules.md', `${before}\n<!-- drifted -->\n`, () => {
      expect(() => {
        run('scripts/gen-design-rules.mjs');
      }).not.toThrow();
    });
    // Regenerating restored it, which is the property CI relies on.
    expect(await readDoc('10-design-rules.md')).toBe(before);
  });

  it('generates the markdown byte for byte', async () => {
    const before = await readDoc('10-design-rules.md');
    run('scripts/gen-design-rules.mjs');
    expect(await readDoc('10-design-rules.md')).toBe(before);
  });
});

describe('the link checker', () => {
  it('reports a broken anchor rather than passing it over', async () => {
    const original = await readDoc('10-design-rules.md');
    const broken = original.replace('#1-gcp-projectと監査領域の構成', '#no-such-heading');
    expect(broken).not.toBe(original);
    await writeTemporarily('docs/10-design-rules.md', broken, () => {
      expect(() => run('scripts/check-docs-links.mjs')).toThrow();
    });
  });

  it('lists what it checked when asked', () => {
    const output = run('scripts/check-docs-links.mjs', '--verbose');
    for (const name of ['09-security-monitoring.md', '11-activity-timeline.md']) {
      expect(output).toContain(`checking docs/${name}`);
    }
  });
});

describe('the glossary check', () => {
  it('fails when a term is dropped from the first table', async () => {
    const original = await readDoc('glossary.md');
    const rows = original.split('\n');
    // The row after the first separator: that is the first term the table defines.
    const index = rows.findIndex((line) => line.startsWith('|---')) + 1;
    expect(rows[index]).toMatch(/^\| /);
    const broken = [...rows.slice(0, index), ...rows.slice(index + 1)].join('\n');
    await writeTemporarily('docs/glossary.md', broken, () => {
      expect(() => run('scripts/check-glossary.mjs')).toThrow();
    });
  });
});

describe('the traceability table', () => {
  it('has one row per rule, in the registry order', async () => {
    const registry = JSON.parse(await readDoc('rules.json')) as { rules: Array<{ id: string }> };
    const rows = (await readDoc('rule-traceability.md')).split('\n').filter((line) => /^\| RULE-\d{2} /.test(line));
    expect(rows).toHaveLength(60);
    expect(rows.map((row) => row.split('|')[1]!.trim())).toEqual(registry.rules.map((rule) => rule.id));
  });

  /**
   * File existence was all this used to check, and a row could name any file that
   * happened to exist. Naming the test as well means the row has to point at something
   * that actually holds the rule up.
   */
  it('points every implemented row at an implementation and a test that hold the rule', async () => {
    const rows = (await readDoc('rule-traceability.md')).split('\n').filter((line) => /^\| RULE-\d{2} /.test(line));
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim().replaceAll('`', ''));
      const [, id, , , impl, test, state] = cells;
      expect(['実装', '未実装']).toContain(state);
      if (state === '未実装') {
        expect([impl, test]).toEqual(['-', '-']);
        continue;
      }
      for (const path of impl!.split('、')) await expectExists(path.trim(), id!);
      const [testPath, testName] = test!.split('::');
      await expectExists(testPath!, id!);
      if (testName) {
        const source = await readFile(join(root, testPath!), 'utf8');
        expect(source, `${id}: ${testPath} has no test named ${testName}`).toContain(testName);
      }
    }
  });

  it('names a REQ-ID that exists, or none at all', async () => {
    const requirements = await readDoc('requirements.md');
    const rows = (await readDoc('rule-traceability.md')).split('\n').filter((line) => /^\| RULE-\d{2} /.test(line));
    for (const row of rows) {
      const requirement = row.split('|')[3]!.trim();
      if (requirement === '-') continue;
      expect(requirement).toMatch(/^REQ-\d{2}-\d{3}$/);
      expect(requirements).toContain(`| ${requirement} |`);
    }
  });

  /**
   * The note has to name a deviation that is still standing. DEV-07 was withdrawn, and
   * a row that still cited it was telling the reader the rule is not kept when it is.
   */
  it('notes only deviations the registry still carries', async () => {
    const registry = await readDoc('deviations.md');
    const withdrawn = registry.split('\n')
      .filter((line) => line.startsWith('| **DEV-') && line.includes('取り下げ'))
      .map((line) => line.split('|')[1]!.trim().replaceAll('*', ''));
    const text = await readDoc('rule-traceability.md');
    for (const id of ['RULE-06', 'RULE-42', 'RULE-44', 'RULE-57']) {
      const row = text.split('\n').find((line) => line.startsWith(`| ${id} `))!;
      expect(row).toMatch(/DEV-\d{2}/);
    }
    for (const note of text.match(/DEV-\d{2}/g) ?? []) {
      expect(registry).toContain(`**${note}**`);
      expect(withdrawn).not.toContain(note);
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

/**
 * The worked example in docs 02 is the first thing a reader copies. When it named a
 * capability the platform does not have — the Calendar one, which only exists with the
 * Bridge switched on — the example described a system nobody can deploy by default.
 */
describe('the worked example in docs 02', () => {
  it('asks only for capabilities the platform actually defines', async () => {
    const text = await readDoc('02-automation-design.md');
    const [body] = text.split('## 付録 A.');
    const capabilities = [...body!.matchAll(/^\s+- ([a-z]+\.[a-z_.]+)$/gm)].map((match) => match[1]!);
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) expect(CAPABILITIES).toContain(capability);
  });

  it('keeps the Bridge example behind the flag that creates the Bridge', async () => {
    const text = await readDoc('02-automation-design.md');
    const appendix = text.split('## 付録 A.')[1]!;
    expect(appendix).toContain('enable_google_bridge=true');
    // The Calendar capability belongs to the appendix and nowhere else.
    expect(text.split('## 付録 A.')[0]).not.toContain('calendar.event.read');
  });
});
