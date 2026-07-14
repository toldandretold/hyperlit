/**
 * gateFilter.ts — the pinned-hypercite deep-link exemption + hypercite gate parity +
 * the conservative singles mirror. These are the CLIENT half of the server-side
 * singles/pinned filtering (DatabaseToIndexedDBController::getHypercites, pinned via
 * tests/Feature/Api/HyperciteGateParityTest.php):
 *   - pinHypercite: shape-validated, sessionStorage-persisted, FIFO-capped at 20
 *   - applyGateFilter: pinned ids always pass (incl. hideAll); foreign singles
 *     (is_user_hypercite === false EXPLICITLY) are dropped in every mode; undefined
 *     ownership is KEPT (local/legacy records must never vanish on their creator)
 *   - global default now hides AI hypercites (parity with hyperlights)
 *   - appendGateParam emits pinned= independently of a stored gate setting
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fresh module state per test — the pinned set is cached at module level.
async function freshGateFilter() {
  vi.resetModules();
  return import('../../../resources/js/components/utilities/gateFilter');
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const single = (over = {}) => ({
  hyperciteId: 'hypercite_s1', relationshipStatus: 'single', citedIN: [],
  creator: 'someone', is_user_hypercite: false, ...over,
});
const couple = (over = {}) => ({
  hyperciteId: 'hypercite_c1', relationshipStatus: 'couple', citedIN: ['/x#hypercite_y'],
  creator: 'someone', is_user_hypercite: false, ...over,
});

describe('pinned set semantics', () => {
  it('pins, persists to sessionStorage, and round-trips through a module reload', async () => {
    let gf = await freshGateFilter();
    gf.pinHypercite('hypercite_abc123');
    expect(gf.getPinnedHyperciteIds()).toEqual(['hypercite_abc123']);
    expect(JSON.parse(sessionStorage.getItem('hyperlit_pinned_hypercites'))).toEqual(['hypercite_abc123']);

    // New module instance (fresh page / different chunk) rehydrates from sessionStorage
    gf = await freshGateFilter();
    expect(gf.getPinnedHyperciteIds()).toEqual(['hypercite_abc123']);
  });

  it('rejects ids that do not match the hypercite shape', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('HL_notacite');
    gf.pinHypercite('hypercite_bad!chars');
    gf.pinHypercite('');
    expect(gf.getPinnedHyperciteIds()).toEqual([]);
  });

  it('FIFO-caps at 20 and re-pinning moves an id to the freshest slot', async () => {
    const gf = await freshGateFilter();
    for (let i = 1; i <= 20; i++) gf.pinHypercite(`hypercite_n${i}`);
    gf.pinHypercite('hypercite_n1'); // re-pin → freshest
    gf.pinHypercite('hypercite_new'); // evicts the OLDEST (n2), not n1
    const pinned = gf.getPinnedHyperciteIds();
    expect(pinned).toHaveLength(20);
    expect(pinned).toContain('hypercite_n1');
    expect(pinned).toContain('hypercite_new');
    expect(pinned).not.toContain('hypercite_n2');
  });
});

describe('applyGateFilter: singles mirror', () => {
  it('drops a foreign single (is_user_hypercite === false) in every mode', async () => {
    const gf = await freshGateFilter();
    for (const mode of ['default', 'all', 'custom']) {
      localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode, custom: {} }));
      const out = gf.applyGateFilter([single(), couple()], 'hypercite');
      expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_c1']);
    }
  });

  it('KEEPS the user\'s own single and KEEPS undefined ownership (local/legacy records)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const own = single({ hyperciteId: 'hypercite_own', is_user_hypercite: true });
    const legacy = single({ hyperciteId: 'hypercite_legacy', is_user_hypercite: undefined });
    const out = gf.applyGateFilter([own, legacy], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_own', 'hypercite_legacy']);
  });

  it('a PINNED foreign single passes (deep-link target must render)', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_s1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const out = gf.applyGateFilter([single()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_s1']);
  });
});

describe('applyGateFilter: pinned bypass of gate modes', () => {
  it('hideAll keeps only own + pinned hypercites', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_c1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    const own = couple({ hyperciteId: 'hypercite_mine', is_user_hypercite: true });
    const foreign = couple({ hyperciteId: 'hypercite_other' });
    const out = gf.applyGateFilter([own, couple(), foreign], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_mine', 'hypercite_c1']);
  });

  it('custom hideAI drops AI hypercites but keeps a pinned AI one', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_aipinned');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'custom', custom: { hideAI: true } }));
    const ai = couple({ hyperciteId: 'hypercite_ai', creator: 'AIreview:gpt' });
    const aiPinned = couple({ hyperciteId: 'hypercite_aipinned', creator: 'AIreview:gpt' });
    const out = gf.applyGateFilter([ai, aiPinned, couple()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_aipinned', 'hypercite_c1']);
  });
});

describe('applyGateFilter: global-default parity', () => {
  it('global default hides AI hypercites (parity with hyperlights) but keeps normal couples', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const ai = couple({ hyperciteId: 'hypercite_ai', creator: 'AIreview:gpt' });
    const out = gf.applyGateFilter([ai, couple()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_c1']);
  });

  it('the empty-annotation default check stays hyperlight-only (hypercites have no annotation)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    // A couple with no annotation field must NOT be dropped by the hideNoAnnotation default
    const out = gf.applyGateFilter([couple()], 'hypercite');
    expect(out).toHaveLength(1);
  });
});

describe('appendGateParam', () => {
  it('emits pinned= even when NO gate setting is stored (fresh user following a deep link)', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_deep1');
    const url = gf.appendGateParam('/api/x');
    expect(url).toBe(`/api/x?pinned=${encodeURIComponent('hypercite_deep1')}`);
  });

  it('emits both gate= and pinned= when both exist', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    gf.pinHypercite('hypercite_deep1');
    const url = gf.appendGateParam('/api/x?foo=1');
    expect(url).toContain('&gate=');
    expect(url).toContain('&pinned=');
  });

  it('returns the url unchanged with no gate and no pins', async () => {
    const gf = await freshGateFilter();
    expect(gf.appendGateParam('/api/x')).toBe('/api/x');
  });
});
