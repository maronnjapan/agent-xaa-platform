import { describe, expect, it } from 'vitest';
import { assertAgentOwnership, assertPath, FirestoreGuardError } from '../src/index.js';

describe('Firestore path guard', () => {
  // Authorization does read catalog_tools: REQ-03-021 has it resolve the
  // capability-to-connector map before the Policy Engine runs. What it must not
  // reach is another app's data.
  it('denies cross-app path access', () => expect(() => assertPath('authorization', 'read', 'documents/x')).toThrow());
  it('authorization may read the tool catalogue but not write it', () => {
    expect(() => assertPath('authorization', 'read', 'catalog_tools/x')).not.toThrow();
    expect(() => assertPath('authorization', 'write', 'catalog_tools/x')).toThrow();
  });
  it('authorization cannot read idp_connections', () => expect(() => assertPath('authorization', 'read', 'idp_connections/x')).toThrow());
  it('bridge cannot read agent registrations', () => expect(() => assertPath('google-bridge', 'read', 'agents/x/meta')).toThrow());
  it('agents2 does not match agents glob', () => expect(() => assertPath('provisioner', 'read', 'agents2/x')).toThrow());
  // T-RES-02: each Resource server is confined to its own collections. A documents
  // identifier reaching the payments collection is the case that must never work.
  it('denies a Resource AS reaching another resource\'s data with path_not_allowed', () => {
    expect(() => assertPath('resource-docs-as', 'read', 'payments/pay_x')).toThrow(FirestoreGuardError);
    try {
      assertPath('resource-docs-as', 'read', 'payments/pay_x');
      expect.unreachable();
    } catch (error) {
      expect((error as FirestoreGuardError).code).toBe('path_not_allowed');
    }
    expect(() => assertPath('resource-docs-as', 'write', 'oidc_resource_finance_as/x')).toThrow();
    expect(() => assertPath('resource-docs-as', 'write', 'oidc_resource_docs_as/x')).not.toThrow();
  });
  it('denies cross-agent path from runtime', () => expect(() => assertAgentOwnership('agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow());
});
