import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StaticAsset {
  contentType: string;
  /** Candidates in preference order, relative to the package root. */
  files: readonly string[];
}

const SCRIPT_TYPE = 'text/javascript; charset=utf-8';
const STYLE_TYPE = 'text/css; charset=utf-8';

/**
 * Every file the browser may ask for, listed by request path.
 *
 * A table rather than a directory handler: the request path is only ever a key in this
 * map, so no part of it reaches the filesystem and there is no traversal to defend
 * against. Adding an asset is a line here, which is also where someone reviewing what
 * the page loads will look.
 *
 * The stylesheets are looked for in `public/` first — where the build copies them —
 * and in the source tree second, so a checkout that has not been built still serves a
 * styled page.
 */
export const STATIC_ASSETS: Readonly<Record<string, StaticAsset>> = {
  '/agent-detail.js': { contentType: SCRIPT_TYPE, files: ['public/agent-detail.js'] },
  '/home.js': { contentType: SCRIPT_TYPE, files: ['public/home.js'] },
  '/timeline.js': { contentType: SCRIPT_TYPE, files: ['public/timeline.js'] },
  '/work-definition.js': { contentType: SCRIPT_TYPE, files: ['public/work-definition.js'] },
  '/styles/app.css': {
    contentType: STYLE_TYPE,
    files: ['public/styles/app.css', 'src/ui/styles/app.css'],
  },
  '/styles/emphasis.css': {
    contentType: STYLE_TYPE,
    files: ['public/styles/emphasis.css', 'src/ui/styles/emphasis.css'],
  },
  '/styles/replay.css': {
    contentType: STYLE_TYPE,
    files: ['public/styles/replay.css', 'src/ui/styles/replay.css'],
  },
};

const cache = new Map<string, string>();

/**
 * Reads an asset by walking up from this module until the file turns up.
 *
 * The walk is what makes the same code work from `src` and from `dist`, whose depths
 * below the package root differ. The result is cached: these files change when the
 * image is built, never while it runs.
 */
export function readAsset(path: string): { body: string; contentType: string } | null {
  const asset = STATIC_ASSETS[path];
  if (!asset) return null;
  const cached = cache.get(path);
  if (cached !== undefined) return { body: cached, contentType: asset.contentType };

  let directory = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 8; step += 1) {
    for (const file of asset.files) {
      try {
        const body = readFileSync(join(directory, file), 'utf8');
        cache.set(path, body);
        return { body, contentType: asset.contentType };
      } catch {
        // Not at this level; keep climbing.
      }
    }
    directory = dirname(directory);
  }
  return null;
}
