import { build, context } from 'esbuild';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const configs = [
  {
    entryPoints: ['src/ext/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
  },
];

// The webview entry is added by a later task; skip it until it exists.
if (existsSync('src/webview/main.tsx')) {
  configs.push({
    entryPoints: ['src/webview/main.tsx'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: true,
  });
}

for (const c of configs) {
  if (watch) await (await context(c)).watch();
  else await build(c);
}
