/**
 * Anti-drift guard for the SHARED paste engine: scripts/paste-convert.mjs is
 * the backend (Node + happy-dom) entry point that the citation vacuum calls.
 * It must produce the SAME app-native output as the in-process processors the
 * front-end paste path uses — otherwise a paste fix wouldn't truly propagate
 * to the backend (the whole point of sharing the engine).
 *
 * For every real publisher fixture this runs the actual Node script as a
 * subprocess and asserts its counts equal the in-process processor's. If they
 * diverge, the engine is no longer single-source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'clipboard');
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'paste-convert.mjs');

const countMarkers = (html) => ({
  inTextCitations: (html.match(/class="[^"]*\bin-text-citation\b/g) || []).length,
  footnoteMarkers: (html.match(/fn-count-id=/g) || []).length,
});

const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html'));

describe('backend Node entry reproduces in-process processors', () => {
  for (const file of fixtures) {
    it(`${file} — backend output matches frontend`, async () => {
      const html = readFileSync(join(FIXTURE_DIR, file), 'utf8');

      // In-process (front-end path)
      const { processor, formatType } = getProcessorForContent(html);
      const inProc = await processor.process(html, 'b');
      const frontMarkers = countMarkers(inProc.html);

      // Backend Node entry (citation-vacuum path)
      const stdout = execFileSync('node', [SCRIPT], {
        input: JSON.stringify({ html }),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString();
      const back = JSON.parse(stdout);
      expect(back.ok, `backend failed: ${back.reason} ${back.detail || ''}`).toBe(true);
      const backMarkers = countMarkers(back.html);

      expect(back.formatType).toBe(formatType ?? inProc.formatType ?? 'general');
      expect(back.references.length).toBe(inProc.references.length);
      expect(back.footnotes.length).toBe(inProc.footnotes.length);
      expect(backMarkers.inTextCitations).toBe(frontMarkers.inTextCitations);
      expect(backMarkers.footnoteMarkers).toBe(frontMarkers.footnoteMarkers);
    }, 30000);
  }
});
