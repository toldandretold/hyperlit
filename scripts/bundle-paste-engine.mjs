/**
 * Build-time bundler for the shared paste/citation engine.
 *
 * The paste engine (resources/js/paste/) is TypeScript, but the backend citation
 * vacuum runs it under RAW Node (scripts/paste-convert.mjs, spawned by
 * app/Services/ContentFetchService.php) which can't import .ts. So at build time
 * we esbuild-bundle the engine's entry (format-detector) into a single plain-ESM
 * file the Node backend imports. Prod runs pure JS — no TS loader, no per-call cost.
 *
 *   npm run build            → vite build + this (emits scripts/generated/paste-engine.mjs)
 *   npm run build:paste-engine → just this
 *
 * The output is committed and byte-checked by tests/paste/handlers/pasteEngineBundle.drift.test.js
 * (mirrors the visualisation/generated drift guard) so it can never drift from source.
 *
 * npm deps (dompurify, marked, …) stay EXTERNAL — Node resolves them from
 * node_modules at runtime (they're prod `dependencies`), keeping the committed
 * artifact small and stable across dep bumps. DOM globals (window, document,
 * NodeFilter, …) are free globals provided by paste-convert.mjs before import.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Extensionless entry so this survives the .js → .ts rename (esbuild resolves either).
const ENTRY = path.join(ROOT, 'resources/js/paste/format-detection/format-detector');
const OUT = path.join(__dirname, 'generated', 'paste-engine.mjs');

/** Bundle the engine and return the generated code (no write) — used by the drift test. */
export async function buildPasteEngine() {
  const res = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',   // leave npm deps (dompurify/marked) as runtime imports
    minify: false,          // readable + deterministic for the committed drift diff
    legalComments: 'none',
    write: false,
  });
  return res.outputFiles[0].text;
}

async function main() {
  const code = await buildPasteEngine();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code);
  console.log(`✅ paste engine bundled → ${path.relative(ROOT, OUT)} (${code.length} bytes)`);
}

// Run when invoked directly (node scripts/bundle-paste-engine.mjs), not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
