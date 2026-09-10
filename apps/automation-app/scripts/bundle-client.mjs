#!/usr/bin/env node
// Bundles the browser half of the screens, and copies the assets `tsc` does not.
//
// esbuild is the only build step in the UI. There is one entry point and one output,
// because the four screens are one React application (DEC-APP-06, revised): a bundle
// per page would ship React four times, and the page decides what to render from the
// value the server wrote into the document rather than from the script's name.
//
// The output is not minified. Every check that reads the bundle — no datastore SDK, no
// persistent connection — greps it as text, and a build a reviewer can read is the
// point of shipping the framework at all rather than pretending it is not there.
//
// The copies exist because TypeScript emits only what it compiles. The prompt and the
// stylesheets are read at runtime by path, so they have to sit beside the compiled
// module and beside the bundle respectively, or the deployed image would serve a page
// with no styles and answer suggestions with no instructions.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const from = (path) => new URL(`../${path}`, import.meta.url).pathname;

await build({
  entryPoints: [from('client/src/app.tsx')],
  outfile: from('public/app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  // React ships both builds behind this flag. Without it the browser gets the
  // development one, which is slower and prints warnings at people using the app.
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
});

await mkdir(from('public/styles'), { recursive: true });
for (const sheet of ['app.css', 'emphasis.css', 'replay.css']) {
  await copyFile(from(`src/ui/styles/${sheet}`), from(`public/styles/${sheet}`));
}

await mkdir(from('dist/src/prompts'), { recursive: true });
await copyFile(from('src/prompts/suggestion.md'), from('dist/src/prompts/suggestion.md'));
