import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../../../', import.meta.url).pathname;

/**
 * RULE-34 and RULE-42, checked where they are actually decided: in Terraform.
 *
 * The audit dataset and the running platform share one GCP Project (DEV-14), so the
 * separation is IAM rather than a project boundary — an authoritative binding on the
 * dataset, a Log Sink writer identity as the only write path, and no delete-capable
 * role anywhere on the platform side. None of that is visible from application code,
 * which is why the rules had no test and the traceability table pointed at whatever
 * file happened to mention Firestore.
 */
describe('the audit data is separated by IAM, not by project', () => {
  it('keeps the audit dataset authoritative and undeletable by the platform', () => {
    expect(() => execFileSync('bash', ['infra/tests/audit-iam.sh'], { cwd: repoRoot })).not.toThrow();
  });

  /**
   * The other half of the same rule needs a live project to read IAM policies from, so
   * it runs in `infra/tests/verify-all.sh` after a deploy rather than here. What is
   * checkable offline is that the exception list it reads is filled in: an exception
   * with no reason is a forbidden role nobody agreed to.
   */
  it('leaves no unexplained exception in the forbidden-role list', async () => {
    const list = JSON.parse(
      await readFile(new URL('../../../infra/tests/forbidden-roles.json', import.meta.url), 'utf8'),
    ) as { roles: string[]; exceptions: Array<{ member: string; role: string; resource: string; reason: string }> };
    expect(list.roles.length).toBeGreaterThan(0);
    for (const exception of list.exceptions) {
      for (const value of [exception.member, exception.role, exception.resource, exception.reason]) {
        expect(value.trim()).not.toBe('');
      }
    }
  });
});
