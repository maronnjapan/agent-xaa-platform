import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import {
  ADMIN_CONSOLE_CSS, ADMIN_STYLESHEET_PATH, AdminErrors, isChecked, readFormInput, renderAdminPage, wantsJson,
} from '../src/index.js';

const NAV = [{ href: '/admin/things', label: 'もの' }] as const;

function post(body: BodyInit, headers: Record<string, string>): Request {
  return new Request('https://console.test/admin/things', { method: 'POST', headers, body });
}

describe('the console shell', () => {
  it('serves a whole document, with the stylesheet the apps serve', () => {
    const html = renderAdminPage({ title: 'もの一覧', nav: NAV, body: createElement('p', null, '本文') });

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`href="${ADMIN_STYLESHEET_PATH}"`);
    expect(html).toContain('<title>もの一覧</title>');
    expect(html).toContain('<h1>もの一覧</h1>');
    expect(html).toContain('<a href="/admin/things">もの</a>');
  });

  /**
   * The whole reason the consoles render on the server and ship nothing: there is no
   * bundle to load, so there is no client-side code for a datastore SDK to hide in
   * (RULE-57), and the screens work in a browser running no script at all.
   */
  it('ships no script', () => {
    const html = renderAdminPage({ title: 'もの一覧', nav: NAV, body: null });
    expect(html).not.toContain('<script');
  });

  /**
   * The stored values are somebody's title and somebody's description, and React is what
   * keeps a `<script>` in one of them a piece of text rather than a piece of the page.
   */
  it('renders a value that looks like markup as text', () => {
    const html = renderAdminPage({
      title: 'もの一覧', nav: NAV, body: createElement('p', null, '<script>alert(1)</script>'),
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says every problem at once, or nothing at all', () => {
    const listed = renderAdminPage({ title: 't', nav: NAV, body: AdminErrors({ errors: ['一つ目', '二つ目'] }) });
    expect(listed).toContain('一つ目');
    expect(listed).toContain('二つ目');
    expect(renderAdminPage({ title: 't', nav: NAV, body: AdminErrors({ errors: [] }) })).not.toContain('class="errors"');
  });

  it('carries the stylesheet as bytes rather than a path on disk', () => {
    // `pnpm deploy` copies compiled output, not sources, so a `.css` file beside the
    // components would be absent from the image and present everywhere else.
    expect(ADMIN_CONSOLE_CSS).toContain('nav.admin-nav');
    expect(ADMIN_STYLESHEET_PATH.startsWith('/admin/')).toBe(true);
  });
});

describe('reading what a console screen was sent', () => {
  it('reads a form post and a JSON body into the same shape', async () => {
    const form = await readFormInput(post(
      new URLSearchParams({ capability_id: 'contract.review', delegatable: 'on' }).toString(),
      { 'content-type': 'application/x-www-form-urlencoded' },
    ));
    const json = await readFormInput(post(
      JSON.stringify({ capability_id: 'contract.review', delegatable: true }),
      { 'content-type': 'application/json' },
    ));

    expect(form).toEqual({ capability_id: 'contract.review', delegatable: 'on' });
    expect(json).toEqual({ capability_id: 'contract.review', delegatable: 'on' });
  });

  it('reads a JSON false as an unticked box rather than the string "false"', async () => {
    const input = await readFormInput(post(JSON.stringify({ delegatable: false }), { 'content-type': 'application/json' }));
    expect(isChecked(input.delegatable)).toBe(false);
  });

  it('answers a broken body with no fields instead of throwing', async () => {
    expect(await readFormInput(post('{', { 'content-type': 'application/json' }))).toEqual({});
  });

  it('sends a browser HTML and a script JSON', () => {
    const browser = new Request('https://console.test/admin/things', { headers: { accept: 'text/html' } });
    const script = new Request('https://console.test/admin/things', { headers: { accept: 'application/json' } });
    const poster = post('{}', { 'content-type': 'application/json' });

    expect(wantsJson(browser)).toBe(false);
    expect(wantsJson(script)).toBe(true);
    // A `curl` that sends JSON and states no preference still gets JSON back.
    expect(wantsJson(poster)).toBe(true);
  });
});
