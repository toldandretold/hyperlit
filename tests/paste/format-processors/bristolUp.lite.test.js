/**
 * @vitest-environment jsdom
 *
 * Bristol UP LITE paste — the export chrome must not enter the book.
 * ==================================================================
 * Small pastes (≤10 nodes) run processLite: normalize + cleanup ONLY. The full
 * pipeline strips each reference's hidden structured-citation duplicate
 * (`div.debug`) and export chrome (`ul.citationActions` — "Search Google
 * Scholar" / "Export Citation") in transformStructure, which LITE skips — so
 * every small paste of a reference carried that junk into the book. It's how
 * the `<ul>` in prod integrity report book_1788217034868 (2026-08-31) got
 * there. The processor now strips it in cleanup(), the one stage both lanes
 * share — and BEFORE super.cleanup(), because stripAttributes removes the class
 * attributes these selectors match on.
 */
import { describe, it, expect } from 'vitest';
import { BristolUPProcessor } from '../../../resources/js/paste/format-processors/bristol-up-processor';

// A reference block as Bristol UP Digital serves it (structure per the
// processor's own header notes: div.reference > p.citationText + div.debug +
// ul.citationActions).
const BRISTOL_REFERENCE = `
  <ul class="refList no-enumerators">
    <li>
      <div class="reference" id="CIT0026">
        <p class="citationText">Mahony, M. and Endfield, G. (2018) Climate and colonialism, <i>WIREs Climate Change</i>, 9(2).</p>
        <div class="debug"><mixed-citation>hidden structured duplicate</mixed-citation></div>
        <ul class="citationActions">
          <li><a class="googleScholar" href="http://scholar.google.com/scholar_lookup?title=Climate+and+colonialism">Search Google Scholar</a></li>
          <li><a class="exportCitation" href="/export">Export Citation</a></li>
        </ul>
      </div>
    </li>
  </ul>`;

describe('BristolUPProcessor.processLite', () => {
  it('keeps the citation text but strips the export chrome and debug duplicate', async () => {
    const processor = new BristolUPProcessor();
    const result = await processor.processLite(BRISTOL_REFERENCE, 'book_test');

    expect(result.html).toContain('Climate and colonialism');
    expect(result.html).not.toContain('Search Google Scholar');
    expect(result.html).not.toContain('Export Citation');
    expect(result.html).not.toContain('hidden structured duplicate');
  });

  it('strips the chrome in the FULL pipeline too (cleanup runs in both lanes)', async () => {
    const processor = new BristolUPProcessor();
    const dom = document.createElement('div');
    dom.innerHTML = BRISTOL_REFERENCE;

    processor.cleanup(dom);

    expect(dom.textContent).toContain('Climate and colonialism');
    expect(dom.textContent).not.toContain('Search Google Scholar');
    expect(dom.textContent).not.toContain('Export Citation');
  });
});
