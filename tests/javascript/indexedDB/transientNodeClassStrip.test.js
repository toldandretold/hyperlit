/**
 * @vitest-environment jsdom
 *
 * Regression: the audio player paints a transient `audio-reading` class onto the
 * node ROOT element (<p data-node-id>) during playback. Editing (or otherwise
 * re-saving) a node while that class is live baked it into stored content →
 * IndexedDB → Postgres, so the node rendered with a permanent playback highlight.
 *
 * The save path (processNodeContentHighlightsAndCites) stripped navigation
 * classes only from DESCENDANTS; a class on the clone ROOT slipped through. This
 * pins the fix: transient node-root classes never survive into `content`.
 */

import { describe, it, expect } from 'vitest';
import { processNodeContentHighlightsAndCites } from '../../../resources/js/indexedDB/nodes/contentProcessor';

function makeNode(innerHTML, rootClass) {
  const p = document.createElement('p');
  p.id = '8000';
  p.setAttribute('data-node-id', 'book_test_node1');
  if (rootClass) p.setAttribute('class', rootClass);
  p.innerHTML = innerHTML;
  document.body.appendChild(p);
  return p;
}

describe('processNodeContentHighlightsAndCites — transient node-root class strip', () => {
  it('strips audio-reading from the node root and drops the empty class attribute', () => {
    const node = makeNode('The NWICO sketched out a critique.', 'audio-reading');

    const { content } = processNodeContentHighlightsAndCites(node, []);

    expect(content).not.toContain('audio-reading');
    expect(content).not.toContain('class=""');
    expect(content).not.toMatch(/class=/); // audio-reading was the only class
    expect(content).toContain('The NWICO sketched out a critique.');
  });

  it('keeps a legitimate root class while removing the transient token', () => {
    const node = makeNode('Body text.', 'keep-me audio-reading');

    const { content } = processNodeContentHighlightsAndCites(node, []);

    expect(content).not.toContain('audio-reading');
    expect(content).toContain('keep-me');
  });

  it('strips cascade-origin too (same root-level hole)', () => {
    const node = makeNode('Body text.', 'cascade-origin');

    const { content } = processNodeContentHighlightsAndCites(node, []);

    expect(content).not.toContain('cascade-origin');
    expect(content).not.toMatch(/class=/);
  });
});
