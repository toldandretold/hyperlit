/**
 * Canonical bibliography heading vocabulary.
 */

import { describe, it, expect } from 'vitest';
import { isReferenceHeading } from '../../../resources/js/paste/utils/reference-headings';

describe('isReferenceHeading', () => {
  it.each([
    'References',
    'REFERENCES',
    '  references  ',
    'Bibliography',
    'Works Cited',
    'Works Consulted',
    'Selected Bibliography',
    'Literature Cited',
    'Reference List',
    'Sources',
    'Primary Sources',
    'Notes and References',
    'References and Further Reading',
    'Further Reading',
    'Literaturverzeichnis',
    'Références',
    'Bibliografía',
  ])('accepts "%s"', (text) => {
    expect(isReferenceHeading(text)).toBe(true);
  });

  it.each([
    ['7. References', 'numeric enumerator'],
    ['7) References', 'numeric enumerator with paren'],
    ['References:', 'trailing colon'],
    ['Appendix A: References', 'appendix prefix'],
    ['Chapter 3 - Bibliography', 'chapter prefix'],
    ['IV. References', 'roman enumerator'],
    ['3.2 References', 'dotted section number'],
  ])('accepts "%s" (%s)', (text) => {
    expect(isReferenceHeading(text)).toBe(true);
  });

  // DELIBERATE CARVE-OUT. These belong to the FOOTNOTE system: extractFootnotes
  // runs before reference extraction, and dom-utils' isReferenceSectionHeading
  // (a section-REMOVAL matcher) already covers them. Letting bibliography
  // detection claim them would steal note sections from the footnote extractor.
  it.each(['Notes', 'Endnotes', 'Footnotes', 'End Notes', 'Note'])(
    'rejects "%s" — the footnote system owns this heading',
    (text) => {
      expect(isReferenceHeading(text)).toBe(false);
    },
  );

  it.each([
    'Introduction',
    'Acknowledgements',
    'Abstract',
    'Reference architecture for distributed systems',
    'Sources of Chinese Tradition',
    '',
    null,
    undefined,
  ])('rejects "%s"', (text) => {
    expect(isReferenceHeading(text)).toBe(false);
  });
});
