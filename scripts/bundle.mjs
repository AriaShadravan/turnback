// Bundle src/ into self-contained ESM files, so dist/ runs without node_modules
// (the Claude Code plugin is fetched from npm without installing dependencies).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  // recorder and store are separate entries for scripts/benchmark.mjs.
  entryPoints: ['src/cli.ts', 'src/recorder.ts', 'src/store.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Keeps the MCP SDK in its own chunk, loaded only by `turnback mcp`.
  splitting: true,
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: { js: "import { createRequire as __turnbackRequire } from 'node:module'; const require = __turnbackRequire(import.meta.url);" },
  logLevel: 'warning',
});
