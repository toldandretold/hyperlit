/**
 * The loading curtain must never outlive a failed boot.
 *
 * Every mechanism that lifts the reader's opaque resume curtain — RevealGate's
 * 4s hold cap, the ProgressOverlayEnactor's hide paths — ships INSIDE the
 * module graph. So the one failure where the curtain matters most, the module
 * graph failing to load, is the one failure none of them can answer: the page
 * sits on a black screen reading "Restoring your reading position…" with no
 * exit but Clear Site Data. Observed on prod 2026-10-08, minutes after a
 * deploy: `Importing a module script failed` out of readerEntry, curtain still
 * `data-hl-hold="1"` and opaque.
 *
 * The answer has to live in the inline <script> in layout.blade.php, because
 * that is the only code still running when no module loads. This test extracts
 * that script and RUNS it, rather than grepping for it — the point is the
 * behaviour, and a grep would pass on a release function nothing ever calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const layout = readFileSync(join(ROOT, 'resources', 'views', 'layout.blade.php'), 'utf8');

/** The head self-heal block — pure JS, no blade directives. */
const healScript = layout
  .split('<script>')
  .find((block) => block.includes('Deploy self-heal'))
  ?.split('</script>')[0];

function mountCurtain() {
  document.body.innerHTML = `
    <div id="initial-navigation-overlay" data-hl-hold="1"
         style="display: block; background: rgba(9, 10, 13, 0.98);"></div>`;
  return document.getElementById('initial-navigation-overlay');
}

function fireChunkError() {
  const ev = new Event('unhandledrejection');
  ev.reason = new Error('Importing a module script failed.');
  window.dispatchEvent(ev);
}

describe('a failed boot cannot leave the curtain up', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__hlReleaseCurtain;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('extracts the inline self-heal script (it must stay inline + blade-free)', () => {
    expect(healScript).toBeTruthy();
    // A blade directive here would mean the block can't be reasoned about (or
    // tested) as plain JS — and this is the code that runs when nothing else can.
    expect(healScript).not.toMatch(/\{\{|@if|@php/);
  });

  it('uncovers the page when a chunk fails and the one-shot reload is spent', () => {
    const overlay = mountCurtain();
    // A reload already happened in this tab seconds ago: healChunkError bails
    // out rather than looping — which used to mean the curtain stayed forever.
    sessionStorage.setItem('hl_chunk_reload', String(Date.now()));

    new Function(healScript)();
    fireChunkError();

    expect(overlay.style.display).toBe('none');
    expect(overlay.dataset.hlHold).toBeUndefined();
  });

  it('leaves a healthy curtain alone — release is for failures only', () => {
    const overlay = mountCurtain();
    new Function(healScript)();

    // An unrelated rejection must not tear the curtain down mid-restore.
    const ev = new Event('unhandledrejection');
    ev.reason = new Error('some unrelated promise blew up');
    window.dispatchEvent(ev);

    expect(overlay.style.display).toBe('block');
    expect(overlay.dataset.hlHold).toBe('1');
  });

  it('exposes the release as a global the rest of the page can call', () => {
    new Function(healScript)();
    expect(typeof window.__hlReleaseCurtain).toBe('function');
  });

  it('arms a timer for a boot that fails with no error we recognise', () => {
    // The body script escalates the curtain at first paint; it must also arm
    // the dead-man. (Source check: that block reads body attributes and
    // storage, so running it would be testing the fixture, not the rule.)
    const escalation = layout.slice(layout.indexOf("overlay.dataset.hlHold = '1'"));
    const timer = escalation.match(/window\.__hlReleaseCurtain\([^)]*\);[\s\S]{0,80}?\}, (\d+)\)/);
    expect(timer, 'curtain escalation must arm __hlReleaseCurtain on a timer').toBeTruthy();
    // Long enough that a slow-but-healthy load never trips it (RevealGate caps
    // its hold at 4s), short enough that a dead page isn't a dead page for long.
    expect(Number(timer[1])).toBeGreaterThanOrEqual(10000);
    expect(Number(timer[1])).toBeLessThanOrEqual(30000);
  });
});
