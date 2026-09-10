import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS } from '../src/ui/replay/config.js';

/**
 * What may and may not end up in front of a person's browser.
 *
 * These read the repository rather than render anything, so they run with no DOM: a
 * spec that asks for one is handed a `import.meta.url` the filesystem does not have,
 * and every path below would be looked for somewhere that does not exist. The
 * rendering tests live in `ui.spec.ts`, which does ask for a DOM.
 */
const repoRoot = new URL('../../../', import.meta.url).pathname;

describe('what the frontend is built from', () => {
  /**
   * DEC-APP-06 (revised) admits React and an animation library and still admits no
   * graph library. The eight boxes are at coordinates written down by hand, because a
   * layout engine would place them somewhere else as the event set changed and a
   * person comparing two replays needs the picture to be in the same place both times.
   */
  it('names no graph library, and draws its own diagram', async () => {
    const manifest = JSON.parse(await readFile(`${repoRoot}apps/automation-app/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const forbidden of ['mermaid', 'd3', 'cytoscape', 'reactflow', '@xyflow/react', 'dagre', 'elkjs']) {
      expect(Object.keys(manifest.dependencies)).not.toContain(forbidden);
    }
    expect(Object.keys(manifest.dependencies)).toContain('react');
  });
});

describe('the pace of a replay', () => {
  it('names each length in one place', async () => {
    for (const [name, value] of [['REPLAY_STEP_MS', REPLAY_STEP_MS], ['REPLAY_MOTION_MS', REPLAY_MOTION_MS]] as const) {
      const hits = execFileSync('bash', ['-c',
        `grep -rn '${name}' apps/automation-app/src apps/automation-app/client/src`],
        { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
      expect(hits.filter((line) => line.includes('export const'))).toHaveLength(1);
      expect(hits.length).toBeGreaterThan(1);
      // The number itself occurs only on the line that names it. A duration written out
      // again in the stylesheet or in a timer is a second answer waiting to disagree.
      const literals = execFileSync('bash', ['-c',
        `grep -rn '${value}' apps/automation-app/src apps/automation-app/client/src || true`],
        { cwd: repoRoot, encoding: 'utf8' }).trim();
      expect(literals.split('\n').filter((line) => line !== '' && !line.includes(`${name} = ${value}`))).toEqual([]);
    }
  });
});

describe('the frontend bundle', () => {
  it('carries no datastore SDK and holds no connection open', () => {
    // The Firestore check lives with the other static infra checks, where CI runs it.
    expect(() => execFileSync('bash', ['infra/tests/no-firestore-sdk-in-frontend.sh'], { cwd: repoRoot })).not.toThrow();
    expect(() => execFileSync('bash', ['scripts/checks/no-persistent-connection.sh'], { cwd: repoRoot })).not.toThrow();
  });

  it('passes every automation-app boundary check', () => {
    for (const script of [
      'no-offline-access-in-automation-app.sh', 'no-authz-vocabulary-in-automation-app.sh',
      'no-capability-update-route.sh', 'no-recording-switch.sh', 'no-cross-user-route.sh',
      'no-demo-route.sh', 'no-fake-actor-token.sh', 'activity-event-single-channel.sh',
      'no-direct-vertex-sdk.sh',
    ]) {
      expect(() => execFileSync('bash', [`scripts/checks/${script}`], { cwd: repoRoot })).not.toThrow();
    }
  });

  /**
   * A check that passes because it looks at nothing is worth nothing. Each of these
   * plants the violation the check exists for, inside the directory it scans, and
   * requires it to be refused — then takes the violation away again.
   */
  it('refuses the authorization vocabulary once it appears in the source', () => {
    const probe = `${repoRoot}apps/automation-app/src/__vocabulary-probe.ts`;
    // Assembled from two halves so this spec file is not itself a hit for the grep it
    // is testing; the file written to disk contains the word.
    writeFileSync(probe, `export const level = '${['full', 'isolation'].join('_')}';\n`);
    try {
      expect(() => execFileSync('bash', ['scripts/checks/no-authz-vocabulary-in-automation-app.sh'], { cwd: repoRoot }))
        .toThrow();
    } finally {
      rmSync(probe, { force: true });
    }
    expect(() => execFileSync('bash', ['scripts/checks/no-authz-vocabulary-in-automation-app.sh'], { cwd: repoRoot }))
      .not.toThrow();
  });

  it('refuses a renderer that imports something which decides', () => {
    const fixture = `${repoRoot}apps/automation-app/test/fixtures/ui-decision-violation.fixture.ts`;
    const probe = `${repoRoot}apps/automation-app/src/ui/__decision-probe.ts`;
    copyFileSync(fixture, probe);
    try {
      expect(() => execFileSync('npx', ['eslint', 'apps/automation-app/src/ui/__decision-probe.ts'], { cwd: repoRoot }))
        .toThrow();
    } finally {
      rmSync(probe, { force: true });
    }
    // Where it lives, the same file lints clean — which is why `pnpm lint` is green.
    expect(() => execFileSync('npx', ['eslint', 'apps/automation-app/test/fixtures/ui-decision-violation.fixture.ts'], { cwd: repoRoot }))
      .not.toThrow();
  }, 120_000);
});
