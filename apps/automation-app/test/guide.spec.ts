import { describe, expect, it } from 'vitest';
import { startAutomationApp } from './helpers.js';
import { GUIDE_LEAD } from '../src/ui/pages/guide.js';

/**
 * The guide, as it is actually served.
 *
 * A guide that named a screen it does not link to, or that sat on a page nothing points
 * at, would be worse than none: the reader would be told a step exists and left to find
 * it. These assertions are about the page being reachable from every screen, and about
 * every screen it describes being reachable from it.
 */

describe('the guide page', () => {
  it('is served as HTML with the steps in the order they are taken', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/guide');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data-page="guide"');
    expect(html).toContain(GUIDE_LEAD);
    const steps = [...html.matchAll(/data-step="([a-z]+)"/g)].map((match) => match[1]);
    expect(steps).toEqual(['describe', 'confirm', 'decide', 'approve', 'operate', 'notes', 'trouble']);
  });

  it('links to every screen the steps send a person to', async () => {
    const harness = await startAutomationApp();
    const html = await (await harness.fetch('/guide')).text();
    // The page's own body, not the navigation every screen already carries.
    const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    expect(body).toContain('href="/"');
    expect(body).toContain('href="/activity"');
  });

  it('is reachable from the navigation of every screen', async () => {
    const harness = await startAutomationApp();
    for (const path of ['/', '/activity', '/guide']) {
      const html = await (await harness.fetch(path)).text();
      expect(html).toContain('href="/guide"');
    }
  });

  it('names no capability and no isolation level, not even as an example', async () => {
    const harness = await startAutomationApp();
    const html = await (await harness.fetch('/guide')).text();
    // RULE-07: this app does not know what those strings mean, and a worked example on
    // the guide is how the vocabulary would come back.
    expect(html).not.toMatch(/document\.(read|write)|finance\.payment\.|full_isolation/);
  });

  it('sends an anonymous browser to the login flow rather than a JSON error', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/guide', { headers: { cookie: '' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });
});
