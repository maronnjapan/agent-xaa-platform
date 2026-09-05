#!/usr/bin/env node
// Bundles the browser halves of the screens, and copies the assets `tsc` does not.
//
// esbuild is the only build step in the UI: there is no framework runtime to ship
// (DEC-APP-06), so the output is the app's own code and nothing else — which is what
// makes the frontend dependency checks meaningful.
//
// The copies exist because TypeScript emits only what it compiles. The prompt and the
// stylesheets are read at runtime by path, so they have to sit beside the compiled
// module and beside the bundle respectively, or the deployed image would serve a page
// with no styles and answer suggestions with no instructions.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const from = (path) => new URL(`../${path}`, import.meta.url).pathname;

await build({
  entryPoints: [
    from('client/src/agent-detail.ts'),
    from('client/src/home.ts'),
    from('client/src/timeline.ts'),
    from('client/src/work-definition.ts'),
  ],
  outdir: from('public'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false,
});

await mkdir(from('public/styles'), { recursive: true });
for (const sheet of ['app.css', 'emphasis.css', 'replay.css']) {
  await copyFile(from(`src/ui/styles/${sheet}`), from(`public/styles/${sheet}`));
}

await mkdir(from('dist/src/prompts'), { recursive: true });
await copyFile(from('src/prompts/suggestion.md'), from('dist/src/prompts/suggestion.md'));
