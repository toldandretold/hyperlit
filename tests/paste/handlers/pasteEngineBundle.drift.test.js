/**
 * Drift guard for the backend paste-engine bundle.
 *
 * The Node citation-vacuum backend (scripts/paste-convert.mjs) imports a prebuilt
 * plain-JS bundle of the (TypeScript) paste engine — scripts/generated/paste-engine.mjs,
 * produced by scripts/bundle-paste-engine.mjs at `npm run build`. This test re-bundles
 * from current source and byte-compares to the committed artifact, so the bundle can
 * never silently drift from the engine source. Mirrors the visualisation/generated
 * byte-check (flowViz.generate.test.js).
 *
 * If this fails: run `npm run build:paste-engine` and commit scripts/generated/paste-engine.mjs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPasteEngine } from '../../../scripts/bundle-paste-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLE = path.join(ROOT, 'scripts/generated/paste-engine.mjs');

describe('backend paste-engine bundle', () => {
  it('committed bundle is up to date (run `npm run build:paste-engine` if this fails)', async () => {
    expect(fs.existsSync(BUNDLE), `${BUNDLE} missing — run \`npm run build:paste-engine\``).toBe(true);
    const fresh = await buildPasteEngine();
    const committed = fs.readFileSync(BUNDLE, 'utf8');
    expect(committed, 'scripts/generated/paste-engine.mjs is stale — run `npm run build:paste-engine` and commit').toBe(fresh);
  }, 30000);
});
