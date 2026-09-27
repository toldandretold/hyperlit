/**
 * citationPathRenderer — the reader-facing "how this citation was checked" block. The review
 * report stores a sanitizer-safe <table data-chart="citation-path"> per claim (contract:
 * data-recorded on the table; per row data-band/data-kind, cells = question | narration with an
 * optional GitHub link — ClaimMarkdownFormatter::buildPathTableMd). These tests pin the contract
 * from the table side, same idiom as graphRenderer.test.js.
 */
import { describe, it, expect } from 'vitest';
import { renderCitationPaths, renderReviewMethod } from '../../../resources/js/lazyLoader/citationPathRenderer';

function tableWith(rows, recorded = '1') {
  const container = document.createElement('div');
  container.innerHTML =
    `<table data-chart="citation-path" data-recorded="${recorded}">`
    + '<thead><tr><th>How this was checked</th><th>What happened</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
  return container;
}

const row = (band, kind, question, text, href = null) =>
  `<tr data-band="${band}" data-kind="${kind}"><td>${question}</td>`
  + `<td>${text}${href ? ` <a href="${href}" target="_blank" rel="noopener">code</a>` : ''}</td></tr>`;

describe('renderCitationPaths', () => {
  it('replaces the marker table with a details block carrying the narration', () => {
    const container = tableWith([
      row('route', 'routed', 'What is the citation?', 'A work to identify.'),
      row('ladder', 'resolved', 'Which work is it?', 'Identified — fetch the URL the citation prints.',
        'https://github.com/toldandretold/hyperlit/blob/main/app/x.php'),
    ]);
    renderCitationPaths(container);

    expect(container.querySelector('table')).toBeNull();
    const details = container.querySelector('details.citation-path');
    expect(details).not.toBeNull();
    expect(details.textContent).toContain('Identified — fetch the URL');
    // The GitHub link survives the swap — the open-science point of the whole block.
    const a = details.querySelector('a[href^="https://github.com/"]');
    expect(a).not.toBeNull();
    expect(a.getAttribute('rel')).toBe('noopener');
  });

  it('the summary chip states the headline outcome at a glance', () => {
    const container = tableWith([
      row('ladder', 'nomatch', 'Which work is it?', 'Not identified — 14 routes tried.'),
    ]);
    renderCitationPaths(container);

    expect(container.querySelector('summary').textContent).toContain('not identified');
  });

  it('an unrecorded path is chipped "not recorded", never hidden', () => {
    const container = tableWith(
      [row('ladder', 'nomatch', 'Which work is it?', 'Not identified.')],
      '0',
    );
    renderCitationPaths(container);

    expect(container.querySelector('summary').textContent).toContain('not recorded');
  });

  it('a malformed table is left in place as its own fallback', () => {
    const container = document.createElement('div');
    container.innerHTML = '<table data-chart="citation-path"><tbody></tbody></table>';
    renderCitationPaths(container);

    expect(container.querySelector('table')).not.toBeNull();
  });

  it('other data-chart tables are not touched', () => {
    const container = document.createElement('div');
    container.innerHTML = '<table data-chart="verdict-summary"><tbody><tr><td>x</td><td>1</td></tr></tbody></table>';
    renderCitationPaths(container);

    expect(container.querySelector('table[data-chart="verdict-summary"]')).not.toBeNull();
  });
});

describe('renderReviewMethod', () => {
  function methodTable() {
    const container = document.createElement('div');
    container.innerHTML =
      '<table data-chart="review-method"><tbody>'
      + '<tr data-band="claim" data-kind="band"><td>What does the text claim?</td><td>read the sentence</td></tr>'
      + '<tr data-band="route" data-kind="band"><td>What is the citation?</td><td>read the footnote</td></tr>'
      + '<tr data-band="ladder" data-kind="band"><td>Which work is it?</td><td>identify the work</td></tr>'
      + '<tr data-band="acq" data-kind="band"><td>Can we read it?</td><td>get the text</td></tr>'
      + '<tr data-band="grades" data-kind="band"><td>What did we actually get?</td><td>graded</td></tr>'
      + '<tr data-band="join" data-kind="band"><td>Does the source support the claim?</td><td>claim meets source</td></tr>'
      + '<tr data-band="citations" data-kind="meta"><td>citations</td><td>119</td></tr>'
      + '<tr data-band="identified" data-kind="meta"><td>identified</td><td>70</td></tr>'
      + '<tr data-band="not_found" data-kind="meta"><td>not_found</td><td>49</td></tr>'
      + '<tr data-band="claims" data-kind="meta"><td>claims</td><td>135</td></tr>'
      + '<tr data-band="ladder" data-kind="step"><td>That DOI at OpenAlex</td><td><a href="https://github.com/toldandretold/hyperlit/blob/main/app/Services/CitationPipeline/Resolution/Waves/OpenAlexDoiLookup.php">code</a></td></tr>'
      + '<tr data-band="verdict" data-kind="verdict"><td>Confirmed</td><td>30</td></tr>'
      + '<tr data-band="verdict" data-kind="verdict"><td>Rejected</td><td>2</td></tr>'
      + '<tr data-band="verdict" data-kind="verdict"><td>Unlikely</td><td>0</td></tr>'
      + '</tbody></table>';
    return container;
  }

  it('replaces the marker table with the fork/join flow chart', () => {
    const container = methodTable();
    renderReviewMethod(container);

    expect(container.querySelector('table')).toBeNull();
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // Every question is on the figure, plus the fork origin and the terminal.
    for (const label of ['WHAT DOES THE TEXT CLAIM?', 'WHICH WORK IS IT?', 'VERDICT', 'THE DOCUMENT’S TEXT']) {
      expect(svg.textContent).toContain(label);
    }
    // The origin box says HOW the text is read: segments around each citation, never the whole
    // body — without this the figure implies the entire document is shipped to a model.
    expect(svg.textContent).toContain('text around each detected in-text citation');
    expect(svg.textContent).toContain('truth-claim pairs');
    // This book's numbers badge the bands — the figure is about THIS review.
    expect(svg.textContent).toContain('70 identified · 49 not found');
    expect(svg.textContent).toContain('119 citations');
    // Edges exist (fork + spine + join).
    expect(svg.querySelectorAll('path').length).toBeGreaterThanOrEqual(5);
    // The verdict FAN: observed outcomes with counts; zero-count verdicts stay off the figure.
    expect(svg.textContent).toContain('Confirmed · 30');
    expect(svg.textContent).toContain('Rejected · 2');
    expect(svg.textContent).not.toContain('Unlikely');
  });

  it('a band with steps expands into linked step rows on click', () => {
    const container = methodTable();
    renderReviewMethod(container);
    const svg1 = container.querySelector('svg');
    expect(svg1.textContent).toContain('1 steps — click to expand');
    expect(svg1.textContent).not.toContain('That DOI at OpenAlex');

    // Click the toggle → the figure re-renders with the step and ITS OWN GitHub link.
    const toggle = Array.from(svg1.querySelectorAll('text')).find((t) => t.textContent.includes('click to expand'));
    // The figure viewer's grab-to-pan captures the pointer and retargets clicks to its scroller;
    // only elements marked data-figure-interactive are exempt. Without this attribute the
    // toggles are dead in fullscreen (they were, twice).
    expect(toggle.hasAttribute('data-figure-interactive')).toBe(true);
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const svg2 = container.querySelector('svg');
    expect(svg2.textContent).toContain('That DOI at OpenAlex');
    expect(svg2.querySelector('a[href*="OpenAlexDoiLookup.php"]')).not.toBeNull();
    // The svg ROOT is stable across re-renders (children swap, root persists) — that is what
    // keeps the single delegated listener alive, and what lets the figure viewer's clone be
    // re-wired once via onMount instead of per-node listeners that cloneNode would drop.
    expect(svg2).toBe(svg1);

    // Collapse again: the same delegated listener still works after the re-render.
    const collapse = Array.from(svg2.querySelectorAll('text')).find((t) => t.textContent.includes('click to collapse'));
    collapse.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('svg').textContent).not.toContain('That DOI at OpenAlex');
  });

  it('edges are layered UNDER the boxes, and boxes occlude with an opaque fill', () => {
    // The verdict fan used to strike straight through "Unverified · 73" — edges now live in a
    // first-child group and every box carries the page-background fill.
    const container = methodTable();
    renderReviewMethod(container);
    const svg = container.querySelector('svg');
    const layers = svg.querySelectorAll(':scope > g');
    expect(layers.length).toBe(2);
    expect(layers[0].querySelectorAll('path').length).toBeGreaterThan(0);   // edge layer first
    expect(layers[0].querySelectorAll('rect').length).toBe(0);
    expect(layers[1].querySelector('rect').getAttribute('fill')).toContain('var(--color-background');
  });

  it('a malformed table stays as its own fallback', () => {
    const container = document.createElement('div');
    container.innerHTML = '<table data-chart="review-method"><tbody></tbody></table>';
    renderReviewMethod(container);
    expect(container.querySelector('table')).not.toBeNull();
  });
});
