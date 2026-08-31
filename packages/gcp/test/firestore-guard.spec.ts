import { describe, expect, it } from 'vitest';
import { assertAgentOwnership, assertPath } from '../src/index.js';

describe('Firestore path guard', () => {
  it('denies cross-app path access', () => expect(() => assertPath('authorization', 'read', 'catalog_tools/x')).toThrow());
  it('authorization cannot read idp_connections', () => expect(() => assertPath('authorization', 'read', 'idp_connections/x')).toThrow());
  it('bridge cannot read agent registrations', () => expect(() => assertPath('google-bridge', 'read', 'agents/x/meta')).toThrow());
  it('agents2 does not match agents glob', () => expect(() => assertPath('provisioner', 'read', 'agents2/x')).toThrow());
  it('denies cross-agent path from runtime', () => expect(() => assertAgentOwnership('agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow());
});
