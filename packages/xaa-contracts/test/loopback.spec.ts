import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, isSecureOrLoopback } from '../src/loopback.js';

/**
 * The carve-out that lets the platform run on one machine, and the reason it widens
 * nothing in a deployment: what it admits is unreachable from any other host.
 */
describe('the loopback exception to https', () => {
  it('admits https anywhere', () => {
    expect(isSecureOrLoopback('https://resource-docs-api-1.asia-northeast1.run.app')).toBe(true);
    expect(isSecureOrLoopback(new URL('https://example.test/path'))).toBe(true);
  });

  it('admits http only on a loopback literal', () => {
    for (const url of ['http://127.0.0.1:8090', 'http://localhost:8090/x', 'http://[::1]:8090']) {
      expect([url, isSecureOrLoopback(url)]).toEqual([url, true]);
    }
  });

  /**
   * The values that would make it a general "http is fine" exception. A name that
   * merely resolves to a loopback address is refused, because resolution can change
   * between the check and the connection.
   */
  it('refuses http anywhere else', () => {
    for (const url of [
      'http://example.test',
      'http://127.0.0.1.attacker.test',
      'http://localhost.attacker.test',
      'http://10.0.0.1',
      'http://[::ffff:127.0.0.1]',
      'ftp://127.0.0.1',
      'not a url',
    ]) {
      expect([url, isSecureOrLoopback(url)]).toEqual([url, false]);
    }
  });

  it('names the three loopback literals and nothing else', () => {
    expect(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1'].every(isLoopbackHostname)).toBe(true);
    expect(['127.0.0.2', 'localhost.test', ''].some(isLoopbackHostname)).toBe(false);
  });
});
