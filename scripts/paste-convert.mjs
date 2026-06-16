/**
 * Backend entry point for the front-end paste conversion engine.
 *
 * The paste processors (resources/js/paste/) are the converter purpose-built
 * for JOURNAL HTML — they emit the app-native interactive format
 * (<a class="in-text-citation">, <sup fn-count-id>, footnote/reference data).
 * They're pure DOM transformers, so we run the SAME code server-side here
 * (Node + happy-dom DOM) for the citation vacuum. One engine, two callers:
 * a paste fix in the browser auto-propagates to the backend.
 *
 * Stdin protocol (JSON): { html }
 * Stdout protocol (JSON): { ok, formatType, html, references, footnotes }
 *                      or { ok: false, reason, detail }
 *
 * DOM setup ordering matters: sanitizeConfig.js binds DOMPurify (and runs
 * addHook) at import time, so the window globals MUST exist before the engine
 * module graph is imported — hence happy-dom first, dynamic import second.
 */

import { Window } from 'happy-dom';

// The processors log progress with console.log; keep stdout pure JSON by
// routing all console output to stderr.
for (const m of ['log', 'info', 'warn', 'debug']) {
  console[m] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let html;
  try {
    html = JSON.parse(raw).html;
  } catch (e) {
    return fail('bad_input', 'stdin JSON parse: ' + e.message);
  }
  if (typeof html !== 'string' || html.length === 0) {
    return fail('bad_input', 'missing html');
  }

  // Provide a DOM the processors (and DOMPurify) can use.
  const window = new Window({ url: 'https://localhost/' });
  globalThis.window = window;
  // Expose the DOM globals the processors + DOMPurify touch (TreeWalker needs
  // NodeFilter; citation/footnote linkers walk + construct nodes).
  for (const name of [
    'document', 'DOMParser', 'Node', 'NodeFilter', 'NodeList', 'Element',
    'HTMLElement', 'Text', 'Comment', 'DocumentFragment', 'navigator',
    'getComputedStyle', 'XMLSerializer',
  ]) {
    if (window[name] !== undefined) globalThis[name] = window[name];
  }

  // Dynamic import AFTER globals exist (DOMPurify binds to window on load).
  let detector;
  try {
    detector = await import('./generated/paste-engine.mjs');
  } catch (e) {
    return fail('engine_load_failed', e.stack || e.message);
  }

  try {
    const { processor, formatType } = detector.getProcessorForContent(html);
    const result = await processor.process(html, 'backendVacuum');

    process.stdout.write(JSON.stringify({
      ok: true,
      formatType: formatType ?? result.formatType ?? 'general',
      html: result.html ?? '',
      references: result.references ?? [],
      footnotes: result.footnotes ?? [],
    }));
  } catch (e) {
    return fail('process_failed', e.stack || e.message);
  }
}

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, reason, detail: String(detail).slice(0, 800) }));
}

main().catch((e) => fail('crash', e.stack || e.message));
