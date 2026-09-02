import { describe, expect, it } from 'vitest';
import { assertAgentOwnership, assertPath } from '../src/index.js';

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
  // The seed Job owns the catalogue (T-IAC-26). Firestore cannot be split by IAM
  // (DEV-05), so this guard is the whole of what stops another writer.
  it('only the seed may write the tool catalogue', () => {
    expect(() => assertPath('provisioner', 'read', 'catalog_tools/x')).not.toThrow();
    expect(() => assertPath('provisioner', 'write', 'catalog_tools/x')).toThrow();
    expect(() => assertPath('seed', 'write', 'catalog_tools/x')).not.toThrow();
  });
  it('denies cross-agent path from runtime', () => expect(() => assertAgentOwnership('agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow());
});
