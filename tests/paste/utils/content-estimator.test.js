/**
 * Tests for content estimation utilities
 */

import { describe, it, expect } from 'vitest';
import { estimatePasteNodeCount, isSmallPaste } from '../../../resources/js/paste/utils/content-estimator.js';

describe('estimatePasteNodeCount', () => {
  it('should count HTML block elements', () => {
    const html = '<p>Para 1</p><p>Para 2</p><h1>Heading</h1>';
    const count = estimatePasteNodeCount(html);
    expect(count).toBe(3);
  });

  it('should count plain text paragraphs', () => {
    const text = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3';
    const count = estimatePasteNodeCount(text);
    expect(count).toBe(3);
  });

  it('should count single lines when no blank lines', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const count = estimatePasteNodeCount(text);
    expect(count).toBe(3);
  });

  it('should count br tags as nodes', () => {
    const html = '<p>Text<br>More text<br>Even more</p>';
    const count = estimatePasteNodeCount(html);
    expect(count).toBe(3); // 1 p + 2 br
  });

  it('should return 1 for empty content', () => {
    expect(estimatePasteNodeCount('')).toBe(1);
    expect(estimatePasteNodeCount('   ')).toBe(1);
  });

  it('should handle non-string input', () => {
    expect(estimatePasteNodeCount(null)).toBe(1);
    expect(estimatePasteNodeCount(undefined)).toBe(1);
    expect(estimatePasteNodeCount(123)).toBe(1);
  });

  it('should count nested lists correctly', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>';
    const count = estimatePasteNodeCount(html);
    expect(count).toBe(3); // 3 li elements
  });
});

describe('isSmallPaste', () => {
  it('should return true for small pastes', () => {
    expect(isSmallPaste(10)).toBe(true);
    expect(isSmallPaste(20)).toBe(true);
  });

  it('should return false for large pastes', () => {
    expect(isSmallPaste(21)).toBe(false);
    expect(isSmallPaste(100)).toBe(false);
  });

  it('should respect custom threshold', () => {
    expect(isSmallPaste(15, 10)).toBe(false);
    expect(isSmallPaste(5, 10)).toBe(true);
  });

  it('should handle edge cases', () => {
    expect(isSmallPaste(0)).toBe(true);
    expect(isSmallPaste(1)).toBe(true);
  });
});
