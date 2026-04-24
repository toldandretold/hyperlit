/**
 * Quantizer View — cascading annotation visualization
 *
 * Left pane:  book text with inline <mark> / <u> highlights
 * Column N:   annotation cards for level N-1's highlights
 * SVG overlays: Bezier connectors between each pair of adjacent columns
 *
 * Clicking a sub-book card expands it, adds a new column to the right
 * with that sub-book's highlights as cards, and so on — infinitely.
 */

document.addEventListener('DOMContentLoaded', () => {
  const data = window.__quantizerData;
  if (!data) return;

  const bookPane = document.getElementById('quantizer-book');
  const cardsPane = document.getElementById('quantizer-cards');
  const svgEl = document.getElementById('quantizer-connectors');
  const columnsEl = document.getElementById('quantizer-columns');
  if (!bookPane || !cardsPane || !svgEl || !columnsEl) return;

  // Collect all annotations into a unified list with sort keys
  const annotations = [];

  for (const hl of (data.hyperlights || [])) {
    const firstNodeId = Array.isArray(hl.node_id) ? hl.node_id[0] : null;
    const charStart = getFirstCharStart(hl.charData);
    const sortLine = getStartLineForNode(bookPane, firstNodeId);
    const previewNodes = Array.isArray(hl.preview_nodes) ? hl.preview_nodes : [];
    const previewHtml = previewNodes.map(n => n.content || '').join('');
    annotations.push({
      type: 'hyperlight',
      id: hl.hyperlight_id,
      annotationId: 'HL_' + hl.hyperlight_id,
      subBookId: hl.sub_book_id || null,
      nodeIds: Array.isArray(hl.node_id) ? hl.node_id : [],
      charData: hl.charData || {},
      text: hl.highlightedText || '',
      previewHtml,
      creator: hl.creator || '',
      timeSince: hl.time_since || '',
      sortLine,
      charStart,
    });
  }

  for (const hc of (data.hypercites || [])) {
    const firstNodeId = Array.isArray(hc.node_id) ? hc.node_id[0] : null;
    const charStart = getFirstCharStart(hc.charData);
    const sortLine = getStartLineForNode(bookPane, firstNodeId);
    annotations.push({
      type: 'hypercite',
      id: hc.hyperciteId,
      annotationId: 'HC_' + hc.hyperciteId,
      nodeIds: Array.isArray(hc.node_id) ? hc.node_id : [],
      charData: hc.charData || {},
      text: hc.hypercitedText || '',
      citedIN: hc.citedIN || [],
      relationshipStatus: hc.relationshipStatus || '',
      creator: hc.creator || '',
      timeSince: hc.time_since || '',
      sortLine,
      charStart,
    });
  }

  // Process footnotes — tag existing <sup> elements and build annotations
  processFootnotes(bookPane, data.footnotes || [], annotations);

  // Sort by position in book
  annotations.sort((a, b) => {
    if (a.sortLine !== b.sortLine) return a.sortLine - b.sortLine;
    return a.charStart - b.charStart;
  });

  // Step A — Apply highlights to book text
  applyAnnotationsToDOM(bookPane, annotations);

  // Step B — Render cards
  renderCards(cardsPane, annotations);

  // Step C — SVG connectors (level 0: book ↔ cards)
  const connector0 = createConnectorOverlay(bookPane, cardsPane, svgEl);

  // Step D — Cascading expansion system
  const cascade = createCascade(columnsEl, bookPane, cardsPane, connector0);

  // Step E — Cross-highlight interaction (works across all columns)
  bindCrossHighlight(columnsEl, cascade);

  // Step F — Scroll following (left drives right)
  bindScrollFollow(bookPane, cardsPane);
});


// ─── Helpers ───────────────────────────────────────────────

function getFirstCharStart(charData) {
  if (!charData || typeof charData !== 'object') return 0;
  const first = Object.values(charData)[0];
  if (!first) return 0;
  if (typeof first.charStart === 'number') return first.charStart;
  if (Array.isArray(first) && first[0]?.charStart !== undefined) return first[0].charStart;
  return 0;
}

function getStartLineForNode(bookPane, nodeId) {
  if (!nodeId) return 0;
  const el = bookPane.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
  return el ? parseFloat(el.getAttribute('data-start-line') || '0') : 0;
}

function esc(val) {
  return String(val || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ─── Footnote processing ───────────────────────────────────

function processFootnotes(container, footnotes, annotations) {
  if (!footnotes || !footnotes.length) return;

  for (const fn of footnotes) {
    const fnId = fn.footnoteId;
    if (!fnId) continue;

    // Find the <sup> element — try id match first, then fn-count-id attribute
    let supEl = container.querySelector(`sup#${CSS.escape(fnId)}`);
    if (!supEl) {
      supEl = container.querySelector(`sup[id="${CSS.escape(fnId)}"]`);
    }
    if (!supEl) continue;

    const annotationId = 'FN_' + fnId;

    // Tag the <sup> with data-annotation-id for connector matching
    supEl.setAttribute('data-annotation-id', annotationId);

    // Get sort position from the parent node
    const parentNode = supEl.closest('[data-node-id]');
    const sortLine = parentNode ? parseFloat(parentNode.getAttribute('data-start-line') || '0') : 0;

    // Approximate char position — use the <sup>'s position within its parent text
    let charStart = 0;
    if (parentNode) {
      const textBefore = getTextBeforeElement(parentNode, supEl);
      charStart = textBefore.length;
    }

    const previewNodes = Array.isArray(fn.preview_nodes) ? fn.preview_nodes : [];
    const previewHtml = previewNodes.map(n => n.content || '').join('');

    annotations.push({
      type: 'footnote',
      id: fnId,
      annotationId,
      subBookId: fn.sub_book_id || null,
      nodeIds: [],
      charData: {},
      text: fn.content || '',
      previewHtml,
      sortLine,
      charStart,
    });
  }
}

function getTextBeforeElement(root, target) {
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node === target) break;
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
  }
  return text;
}


// ─── Step A: Apply annotations to DOM ──────────────────────

function applyAnnotationsToDOM(container, annotations) {
  const byNode = new Map();
  for (const ann of annotations) {
    for (const nodeId of ann.nodeIds) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId).push(ann);
    }
  }

  for (const [nodeId, nodeAnnotations] of byNode) {
    const nodeEl = container.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!nodeEl) continue;

    const segments = [];
    for (const ann of nodeAnnotations) {
      const cd = ann.charData[nodeId];
      if (!cd) continue;

      let charStart, charEnd;
      if (typeof cd.charStart === 'number') {
        charStart = cd.charStart;
        charEnd = cd.charEnd;
      } else if (Array.isArray(cd) && cd.length > 0) {
        charStart = cd[0].charStart ?? cd[0];
        charEnd = cd[cd.length - 1].charEnd ?? cd[cd.length - 1];
      } else {
        continue;
      }

      segments.push({ charStart, charEnd, ann });
    }

    segments.sort((a, b) => b.charStart - a.charStart);

    for (const seg of segments) {
      const positions = findPositionsInDOM(nodeEl, seg.charStart, seg.charEnd);
      if (!positions) continue;

      const tag = seg.ann.type === 'hyperlight' ? 'mark' : 'u';
      const wrapper = document.createElement(tag);
      wrapper.setAttribute('data-annotation-id', seg.ann.annotationId);

      try {
        const range = document.createRange();
        range.setStart(positions.startNode, positions.startOffset);
        range.setEnd(positions.endNode, positions.endOffset);
        const contents = range.extractContents();
        wrapper.appendChild(contents);
        range.insertNode(wrapper);
      } catch (e) {
        try {
          const range = document.createRange();
          range.setStart(positions.startNode, positions.startOffset);
          range.setEnd(positions.endNode, positions.endOffset);
          range.surroundContents(wrapper);
        } catch (_) { /* skip */ }
      }
    }
  }
}


// ─── Step B: Render cards ──────────────────────────────────

function renderCards(cardsPane, annotations) {
  const html = annotations.map(ann => {
    const id = ann.annotationId;
    if (ann.type === 'hyperlight') {
      const hasSubBook = !!ann.subBookId;
      return `
        <article class="quantizer-card${hasSubBook ? ' has-subbook' : ''}" data-annotation-id="${esc(id)}"${hasSubBook ? ` data-sub-book-id="${esc(ann.subBookId)}"` : ''}>
          <div class="quantizer-card-meta">
            <span class="badge-hl">highlight</span>
            ${ann.creator ? `<span>${esc(ann.creator)}</span>` : ''}
            ${ann.timeSince ? `<span>${esc(ann.timeSince)}</span>` : ''}
          </div>
          <div class="quantizer-card-preview">${ann.previewHtml || `<p>${esc(ann.text)}</p>`}</div>
          <div class="quantizer-card-expanded" style="display:none;"></div>
        </article>`;
    } else if (ann.type === 'footnote') {
      const hasSubBook = !!ann.subBookId;
      return `
        <article class="quantizer-card${hasSubBook ? ' has-subbook' : ''}" data-annotation-id="${esc(id)}"${hasSubBook ? ` data-sub-book-id="${esc(ann.subBookId)}"` : ''}>
          <div class="quantizer-card-meta">
            <span class="badge-fn">footnote</span>
          </div>
          <div class="quantizer-card-preview">${ann.previewHtml || `<p>${esc(ann.text)}</p>`}</div>
          <div class="quantizer-card-expanded" style="display:none;"></div>
        </article>`;
    } else {
      const cited = Array.isArray(ann.citedIN) ? ann.citedIN.map(c => esc(typeof c === 'object' ? c.title || c.book || '' : c)).join(', ') : '';
      return `
        <article class="quantizer-card" data-annotation-id="${esc(id)}">
          <div class="quantizer-card-meta">
            <span class="badge-hc">citation</span>
            ${ann.relationshipStatus ? `<span>${esc(ann.relationshipStatus)}</span>` : ''}
            ${ann.creator ? `<span>${esc(ann.creator)}</span>` : ''}
          </div>
          <div class="quantizer-card-excerpt">${esc(ann.text)}</div>
          ${cited ? `<div class="quantizer-card-citations">Cited in: ${cited}</div>` : ''}
        </article>`;
    }
  }).join('');
  cardsPane.innerHTML = html;
}


// ─── Cascade: dynamic column expansion system ──────────────

function createCascade(columnsEl, bookPane, cardsPane, connector0) {
  // levels[i] = { expandedCard, expandedEl, svgWrap, svgEl, cardsPane, connector, scrollCleanup }
  const levels = [];

  function updateGridColumns() {
    // Base: 1fr 80px 1fr (book + svg + cards)
    // Each level with a cardsPane adds: 80px 1fr (svg + cards)
    const extraCols = levels.filter(l => l.cardsPane).length;
    const parts = ['1fr', extraCols > 0 ? '80px' : '100px', '1fr'];
    for (let i = 0; i < extraCols; i++) {
      parts.push('80px', '1fr');
    }
    columnsEl.style.gridTemplateColumns = parts.join(' ');
  }

  function collapseFrom(levelIndex) {
    // Remove all levels from levelIndex onward (deepest first)
    while (levels.length > levelIndex) {
      const lvl = levels.pop();
      // Collapse the expanded card
      if (lvl.expandedCard) {
        lvl.expandedCard.classList.remove('is-expanded');
        const el = lvl.expandedCard.querySelector('.quantizer-card-expanded');
        if (el) el.style.display = 'none';
      }
      // Remove DOM elements
      if (lvl.svgWrap && lvl.svgWrap.parentNode) lvl.svgWrap.remove();
      if (lvl.cardsPane && lvl.cardsPane.parentNode) lvl.cardsPane.remove();
      // Clean up scroll listener
      if (lvl.scrollCleanup) lvl.scrollCleanup();
    }
    updateGridColumns();
    // Redraw all remaining connectors
    connector0.redraw();
    for (const lvl of levels) {
      if (lvl.connector) lvl.connector.redraw();
    }
  }

  function redrawAll() {
    connector0.redraw();
    for (const lvl of levels) {
      if (lvl.connector) lvl.connector.redraw();
    }
  }

  // Bind expansion on the initial cards pane (level 0)
  bindPaneExpansion(cardsPane, 0);

  function bindPaneExpansion(pane, levelIndex) {
    pane.addEventListener('click', async (e) => {
      const card = e.target.closest('.quantizer-card.has-subbook');
      if (!card) return;

      const subBookId = card.getAttribute('data-sub-book-id');
      if (!subBookId) return;

      // If this card is already expanded at this level, collapse it and all deeper levels
      if (levels.length > levelIndex && levels[levelIndex].expandedCard === card && card.classList.contains('is-expanded')) {
        collapseFrom(levelIndex);
        return;
      }

      // Collapse everything from this level onward (switching to a different card)
      collapseFrom(levelIndex);

      // Fetch and expand the card
      const expandedEl = card.querySelector('.quantizer-card-expanded');
      if (!expandedEl) return;

      const result = await fetchAndExpandCard(card, subBookId, expandedEl);
      if (result !== 'expanded') return;

      // Build annotations from the sub-book's hyperlights + footnotes
      const subHyperlights = card._subHyperlights || [];
      const subFootnotes = card._subFootnotes || [];
      const annotations = buildAnnotationsFromSubBookData(subHyperlights, subFootnotes, expandedEl);

      if (annotations.length === 0) {
        // No sub-annotations — just show expanded content, no new column
        levels.push({ expandedCard: card, expandedEl, svgWrap: null, svgEl: null, cardsPane: null, connector: null, scrollCleanup: null });
        return;
      }

      // Apply marks to expanded content
      if (!expandedEl.dataset.marksApplied) {
        applyAnnotationsToDOM(expandedEl, annotations);
        expandedEl.dataset.marksApplied = '1';
      }

      // Create new SVG + cards pane and append to grid
      const svgWrap = document.createElement('div');
      svgWrap.className = 'quantizer-links';
      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.classList.add('quantizer-links-svg');
      svgWrap.appendChild(svgEl);

      const newCardsPane = document.createElement('div');
      newCardsPane.className = 'quantizer-pane quantizer-cards-pane';

      columnsEl.appendChild(svgWrap);
      columnsEl.appendChild(newCardsPane);

      // Render cards
      renderCards(newCardsPane, annotations);

      // Update grid
      const lvl = { expandedCard: card, expandedEl, svgWrap, svgEl, cardsPane: newCardsPane, connector: null, scrollCleanup: null };
      levels.push(lvl);
      updateGridColumns();

      // Wait for layout, then create connectors
      requestAnimationFrame(() => {
        redrawAll();
        lvl.connector = createConnectorOverlay(expandedEl, newCardsPane, svgEl);

        // Scroll listener on expanded content
        const onScroll = () => lvl.connector.redraw();
        expandedEl.addEventListener('scroll', onScroll, { passive: true });
        lvl.scrollCleanup = () => expandedEl.removeEventListener('scroll', onScroll);

        // Scroll book pane to matching mark
        scrollAllPanesToAnnotation(card.getAttribute('data-annotation-id'), pane);

        // Auto-scroll horizontally to show the new column
        columnsEl.scrollTo({ left: columnsEl.scrollWidth, behavior: 'smooth' });

        // Bind expansion on the new cards pane for the next level
        bindPaneExpansion(newCardsPane, levelIndex + 1);
      });
    });
  }

  function scrollAllPanesToAnnotation(annId, sourcePane) {
    if (!annId) return;
    const sel = `[data-annotation-id="${CSS.escape(annId)}"]`;
    const allPanes = getAllPanes();
    for (const pane of allPanes) {
      if (pane === sourcePane) continue;
      const target = pane.querySelector(sel);
      if (!target) continue;
      const scroller = target.closest('.quantizer-card-expanded') || pane;
      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (targetRect.top >= scrollerRect.top && targetRect.bottom <= scrollerRect.bottom) continue;
      const offset = targetRect.top - scrollerRect.top + scroller.scrollTop - 20;
      scroller.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    }
  }

  function getAllPanes() {
    const panes = [bookPane, cardsPane];
    for (const lvl of levels) {
      if (lvl.cardsPane) panes.push(lvl.cardsPane);
    }
    return panes;
  }

  return { levels, redrawAll, getAllPanes, scrollAllPanesToAnnotation, collapseFrom };
}

async function fetchAndExpandCard(card, subBookId, expandedEl) {
  // Toggle off
  if (card.classList.contains('is-expanded')) {
    card.classList.remove('is-expanded');
    expandedEl.style.display = 'none';
    return 'collapsed';
  }

  // Already loaded
  if (expandedEl.dataset.loaded) {
    card.classList.add('is-expanded');
    expandedEl.style.display = '';
    return 'expanded';
  }

  // Fetch
  expandedEl.innerHTML = '<p class="quantizer-loading">Loading...</p>';
  expandedEl.style.display = '';
  card.classList.add('is-expanded');

  try {
    const slashIdx = subBookId.indexOf('/');
    if (slashIdx === -1) throw new Error('Invalid sub_book_id format');
    const parentBook = encodeURIComponent(subBookId.substring(0, slashIdx));
    const subId = subBookId.substring(slashIdx + 1);
    const resp = await fetch(`/q/${parentBook}/${subId}/data`);
    if (!resp.ok) throw new Error(resp.statusText);
    const apiData = await resp.json();
    const nodes = Array.isArray(apiData.nodes) ? apiData.nodes : [];

    const content = nodes
      .sort((a, b) => a.startLine - b.startLine)
      .map(n => `<div class="quantizer-node" data-node-id="${esc(n.node_id)}">${n.content || ''}</div>`)
      .join('');
    expandedEl.innerHTML = content || '<p>No content</p>';
    expandedEl.dataset.loaded = '1';
    card._subHyperlights = apiData.hyperlights || [];
    card._subFootnotes = apiData.footnotes || [];

    return 'expanded';
  } catch (err) {
    expandedEl.innerHTML = '<p class="quantizer-loading">Failed to load</p>';
    console.error('Quantizer: sub-book load failed', err);
    return 'error';
  }
}

function buildAnnotationsFromSubBookData(hyperlights, footnotes, expandedEl) {
  const annotations = hyperlights.map(hl => {
    const previewNodes = Array.isArray(hl.preview_nodes) ? hl.preview_nodes : [];
    return {
      type: 'hyperlight',
      id: hl.hyperlight_id,
      annotationId: 'HL_' + hl.hyperlight_id,
      subBookId: hl.sub_book_id || null,
      nodeIds: Array.isArray(hl.node_id) ? hl.node_id : [],
      charData: hl.charData || {},
      text: hl.highlightedText || '',
      previewHtml: previewNodes.map(n => n.content || '').join(''),
      creator: hl.creator || '',
      timeSince: hl.time_since || '',
      sortLine: 0,
      charStart: getFirstCharStart(hl.charData),
    };
  });

  // Process footnotes in the expanded sub-book content
  if (expandedEl && footnotes && footnotes.length) {
    processFootnotes(expandedEl, footnotes, annotations);
  }

  annotations.sort((a, b) => {
    if (a.sortLine !== b.sortLine) return a.sortLine - b.sortLine;
    return a.charStart - b.charStart;
  });
  return annotations;
}


// ─── SVG connectors ────────────────────────────────────────

function createSvgNode(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function createConnectorOverlay(leftPane, rightPane, svgEl) {
  let rafId = 0;
  let activeId = '';
  const bandInset = 4;

  const redrawNow = () => {
    rafId = 0;
    const rootRect = svgEl.getBoundingClientRect();
    const width = Math.max(1, Math.round(rootRect.width));
    const height = Math.max(1, Math.round(rootRect.height));
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgEl.innerHTML = '';

    const leftRect = leftPane.getBoundingClientRect();
    const rightRect = rightPane.getBoundingClientRect();
    const leftX = leftRect.right - rootRect.left;
    const rightX = rightRect.left - rootRect.left;
    if (rightX <= leftX + 12) return;

    const cardsByAnn = new Map();
    for (const card of rightPane.querySelectorAll('[data-annotation-id]')) {
      cardsByAnn.set(card.getAttribute('data-annotation-id'), card);
    }

    const marks = leftPane.querySelectorAll('[data-annotation-id]');
    let drawn = 0;

    for (const mark of marks) {
      if (drawn >= 50) break;
      const annId = mark.getAttribute('data-annotation-id');
      if (!annId) continue;
      const card = cardsByAnn.get(annId);
      if (!card) continue;

      const markRect = mark.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();

      if (markRect.bottom < leftRect.top && cardRect.bottom < rightRect.top) continue;
      if (markRect.top > leftRect.bottom && cardRect.top > rightRect.bottom) continue;

      const lTop = Math.max(0, Math.min(height, (markRect.top - rootRect.top) + bandInset));
      const lBot = Math.max(0, Math.min(height, (markRect.bottom - rootRect.top) - bandInset));
      const rTop = Math.max(0, Math.min(height, (cardRect.top - rootRect.top) + bandInset));
      const rBot = Math.max(0, Math.min(height, (cardRect.bottom - rootRect.top) - bandInset));
      const dx = rightX - leftX;
      if (dx < 12 || Math.abs(lBot - lTop) < 2 || Math.abs(rBot - rTop) < 2) continue;

      const c1x = leftX + dx * 0.38;
      const c2x = rightX - dx * 0.38;
      const isActive = activeId && annId === activeId;
      const cls = isActive ? ' is-active' : (activeId ? ' is-muted' : '');

      svgEl.append(
        createSvgNode('path', {
          d: `M ${leftX} ${lTop} C ${c1x} ${lTop}, ${c2x} ${rTop}, ${rightX} ${rTop} L ${rightX} ${rBot} C ${c2x} ${rBot}, ${c1x} ${lBot}, ${leftX} ${lBot} Z`,
          class: `quantizer-link-band${cls}`,
        }),
        createSvgNode('path', {
          d: `M ${leftX} ${lTop} C ${c1x} ${lTop}, ${c2x} ${rTop}, ${rightX} ${rTop}`,
          class: `quantizer-link-path${cls}`,
        }),
        createSvgNode('path', {
          d: `M ${leftX} ${lBot} C ${c1x} ${lBot}, ${c2x} ${rBot}, ${rightX} ${rBot}`,
          class: `quantizer-link-path${cls}`,
        }),
      );
      drawn++;
    }
  };

  const redraw = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(redrawNow);
  };

  const setActive = (id) => { activeId = id; redraw(); };

  leftPane.addEventListener('scroll', redraw, { passive: true });
  rightPane.addEventListener('scroll', redraw, { passive: true });
  window.addEventListener('resize', redraw);
  redraw();

  return { redraw, setActive };
}


// ─── Cross-highlight interaction ───────────────────────────

function bindCrossHighlight(columnsEl, cascade) {
  let hoverId = '';
  let pinnedId = '';

  const currentActive = () => pinnedId || hoverId || '';

  const clear = () => {
    columnsEl.querySelectorAll('.is-linked').forEach(n => n.classList.remove('is-linked'));
  };

  const activate = (id) => {
    clear();
    if (!id) return;
    const sel = `[data-annotation-id="${CSS.escape(id)}"]`;
    columnsEl.querySelectorAll(sel).forEach(n => n.classList.add('is-linked'));
  };

  const sync = () => {
    const id = currentActive();
    activate(id);
    cascade.redrawAll();
  };

  columnsEl.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-annotation-id]');
    if (!el) return;
    hoverId = el.getAttribute('data-annotation-id') || '';
    sync();
  });

  columnsEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-annotation-id]');
    if (!el) return;
    const id = el.getAttribute('data-annotation-id') || '';
    pinnedId = pinnedId === id ? '' : id;
    hoverId = id;
    sync();
    // Scroll other panes to show matching element (skip if it's a sub-book card — expansion handles that)
    const isSubbookCard = el.closest('.quantizer-card.has-subbook');
    if (pinnedId && !isSubbookCard) {
      const sourcePane = el.closest('.quantizer-pane');
      cascade.scrollAllPanesToAnnotation(pinnedId, sourcePane);
    }
  });

  columnsEl.addEventListener('mouseleave', () => {
    hoverId = '';
    sync();
  });
}


// ─── Scroll following ──────────────────────────────────────

function bindScrollFollow(bookPane, cardsPane) {
  let following = true;
  let rafId = 0;

  cardsPane.addEventListener('wheel', () => { following = false; }, { passive: true });
  cardsPane.addEventListener('touchstart', () => { following = false; }, { passive: true });

  bookPane.addEventListener('scroll', () => {
    following = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!following) return;
      scrollCardsToMatch(bookPane, cardsPane);
    });
  }, { passive: true });
}

function scrollCardsToMatch(bookPane, cardsPane) {
  const bookRect = bookPane.getBoundingClientRect();
  const marks = bookPane.querySelectorAll('[data-annotation-id]');
  let firstVisibleId = null;

  for (const mark of marks) {
    const r = mark.getBoundingClientRect();
    if (r.bottom > bookRect.top && r.top < bookRect.bottom) {
      firstVisibleId = mark.getAttribute('data-annotation-id');
      break;
    }
  }

  if (!firstVisibleId) return;

  const card = cardsPane.querySelector(`[data-annotation-id="${CSS.escape(firstVisibleId)}"]`);
  if (!card) return;

  const cardTop = card.offsetTop - cardsPane.offsetTop;
  const target = cardTop - 20;
  cardsPane.scrollTo({ top: target, behavior: 'smooth' });
}


// ─── DOM text-position utilities ───────────────────────────

function getTextNodes(element) {
  const nodes = [];
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      nodes.push(child);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      nodes.push(...getTextNodes(child));
    }
  }
  return nodes;
}

function findPositionsInDOM(rootElement, startChar, endChar) {
  const textNodes = getTextNodes(rootElement);
  let currentIndex = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;

  for (const node of textNodes) {
    const len = node.textContent.length;
    if (currentIndex <= startChar && currentIndex + len > startChar) {
      startNode = node;
      startOffset = startChar - currentIndex;
      break;
    }
    currentIndex += len;
  }

  currentIndex = 0;
  for (const node of textNodes) {
    const len = node.textContent.length;
    if (currentIndex <= endChar && currentIndex + len >= endChar) {
      endNode = node;
      endOffset = endChar - currentIndex;
      break;
    }
    currentIndex += len;
  }

  if (startNode && endNode) return { startNode, startOffset, endNode, endOffset };
  return null;
}
