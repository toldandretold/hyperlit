/**
 * Taylor & Francis: the 2026 platform refresh lowercased the CIT ids.
 *
 * Real prod paste (EJIS, doi 10.1080/0960085X.2026.2642660 — captured in
 * fixtures/clipboard/tandf-2026-lowercase-cit-fragment.html). tandfonline used
 * to emit `data-rid="CIT0087"` / `<li id="CIT0087">`; the new pages emit
 * `cit0087` for exactly the same thing. CSS attribute selectors compare the
 * VALUE case-sensitively, so every `[data-rid^="CIT"]` and `li[id^="CIT"]` in
 * the engine matched nothing and the failure was silent in three places at
 * once:
 *
 *   1. extractReferences() found 0 references (the `li[id^="CIT"]` path),
 *   2. linkCitations() converted 0 anchors — so the raw anchor survived into
 *      the book, carrying a live tandfonline.com href plus its data-* payload,
 *   3. transformStructure() never stripped T&F's literal "Citation" word, so
 *      the prose read "(Ma, Citation2023)" — which ALSO defeats the base
 *      author-year text matcher, the one fallback that could have saved it.
 *
 * The second test builds the same anchors over a lowercase reference list. The
 * reference-list shape (`<li id="cit0087">`) is inferred, not captured: the
 * page is Cloudflare-walled, and the fragment above only carries the anchors.
 * It is a sound inference — Atypon's `data-rid` resolves to an element with
 * that id — but treat the anchor half as the ground truth and this half as the
 * contract we want.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFormat, getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector';
import { TaylorFrancisProcessor } from '../../../resources/js/paste/format-processors/taylor-francis-processor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', 'clipboard', 'tandf-2026-lowercase-cit-fragment.html');

describe('T&F lowercase CIT ids (2026 tandfonline markup)', () => {
  const fragment = readFileSync(FIXTURE, 'utf8');

  it('routes the fragment to the T&F processor', () => {
    expect(detectFormat(fragment)).toBe('taylor-francis');
  });

  it('never leaves T&F\'s literal "Citation" word glued to the year', async () => {
    const { processor } = getProcessorForContent(fragment);
    const result = await processor.process(fragment, 'fixtureBook');

    expect(result.html).not.toMatch(/Citation\d{4}/);
    // The prose the reader actually gets.
    expect(result.html).toContain('(Ma, 2023)');
    expect(result.html).toContain('(Kemmerling &amp; Trampusch, 2023)');
  });

  it('does not ship raw T&F citation anchors into the book', async () => {
    const { processor } = getProcessorForContent(fragment);
    const result = await processor.process(fragment, 'fixtureBook');

    // A citation anchor with no reference to point at (partial selection: the
    // bibliography was never copied) must be unwrapped to text, not left as a
    // live publisher link with its data-* payload.
    expect(result.html).not.toContain('data-rid');
    expect(result.html).not.toContain('data-behaviour');
    expect(result.html).not.toContain('tandfonline.com');
  });

  it('links in-text citations when the bibliography carries lowercase ids', async () => {
    const article = `
      <div class="hlFld-Fulltextoutput">
        <p>There are relevant contributions from communication and media (Ma,
          <a data-rid="cit0087" href="https://www.tandfonline.com/doi/full/10.1080/0960085X.2026.2642660#"
             data-behaviour="toggle-ref" data-ref-type="bibr" data-label="reference">Citation2023</a>),
          critical political economy (Kemmerling &amp; Trampusch,
          <a data-rid="cit0074" href="https://www.tandfonline.com/doi/full/10.1080/0960085X.2026.2642660#"
             data-behaviour="toggle-ref" data-ref-type="bibr" data-label="reference">Citation2023</a>)
          and cultural studies to platform research.</p>
      </div>
      <h2>References</h2>
      <ul class="references">
        <li id="cit0087"><div class="citation">Ma, X. (2023). Platform governance and the media. <i>New Media &amp; Society</i>, 25(4), 701-719.</div></li>
        <li id="cit0074"><div class="citation">Kemmerling, A., &amp; Trampusch, C. (2023). The politics of platform capitalism. <i>Review of International Political Economy</i>, 30(2), 455-478.</div></li>
      </ul>`;

    const processor = new TaylorFrancisProcessor();
    const result = await processor.process(article, 'fixtureBook');

    expect(result.references).toHaveLength(2);
    // Both anchors resolve to an app-native in-text citation.
    const linked = (result.html.match(/class="[^"]*\bin-text-citation\b/g) || []).length;
    expect(linked).toBe(2);
    expect(result.html).not.toMatch(/Citation\d{4}/);
  });

  it('still handles the old uppercase CIT markup identically', async () => {
    const article = `
      <div class="hlFld-Fulltextoutput">
        <p>As argued elsewhere (Ma,
          <a data-rid="CIT0087" href="https://www.tandfonline.com/doi/full/10.1080/09614524.2024.2400160#"
             data-behaviour="toggle-ref" data-ref-type="bibr" data-label="reference"><span class="off-screen">Citation</span>2023</a>).</p>
      </div>
      <h2>References</h2>
      <ul class="references">
        <li id="CIT0087"><div class="citation">Ma, X. (2023). Platform governance and the media. <i>New Media &amp; Society</i>, 25(4), 701-719.</div></li>
      </ul>`;

    const processor = new TaylorFrancisProcessor();
    const result = await processor.process(article, 'fixtureBook');

    expect(result.references).toHaveLength(1);
    expect(result.html).toMatch(/class="[^"]*\bin-text-citation\b/);
    expect(result.html).not.toMatch(/Citation\d{4}/);
  });
});
