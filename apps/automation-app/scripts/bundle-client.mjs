#!/usr/bin/env node
// Bundles the timeline page's browser half. esbuild is the only build step in the UI:
// there is no framework runtime to ship (DEC-APP-06), so the output is the app's own
// code and nothing else — which is what makes the frontend dependency checks meaningful.
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../client/src/timeline.ts', import.meta.url).pathname],
  outfile: new URL('../public/timeline.js', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false,
});
