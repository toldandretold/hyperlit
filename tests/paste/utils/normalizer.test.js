/**
 * Tests for normalizer utilities
 */

import { describe, it, expect } from 'vitest';
import { normalizeQuotes, normalizeSpaces, normalizeContent, escapeHtml } from '../../../resources/js/paste/utils/normalizer.js';

describe('normalizeQuotes', () => {
  it('should convert smart quotes to regular quotes', () => {
    const input = '\u201CHello\u201D \u2018world\u2019';
    const expected = '"Hello" \'world\'';
    expect(normalizeQuotes(input)).toBe(expected);
  });

  it('should convert backticks to single quotes', () => {
    const input = '`quoted text`';
    const expected = '\'quoted text\'';
    expect(normalizeQuotes(input)).toBe(expected);
  });

  it('should handle mixed quote types', () => {
    const input = '"Smart" \'quotes\' and `backticks`';
    const expected = '"Smart" \'quotes\' and \'backticks\'';
    expect(normalizeQuotes(input)).toBe(expected);
  });

  it('should handle empty input', () => {
    expect(normalizeQuotes('')).toBe('');
    expect(normalizeQuotes(null)).toBe(null);
    expect(normalizeQuotes(undefined)).toBe(undefined);
  });
});

describe('normalizeSpaces', () => {
  it('should convert nbsp entities to regular spaces', () => {
    const input = 'Hello&nbsp;world';
    const expected = 'Hello world';
    expect(normalizeSpaces(input)).toBe(expected);
  });

  it('should remove Apple-converted-space spans', () => {
    const input = '<span class="Apple-converted-space">&nbsp;</span>text';
    const expected = ' text';
    expect(normalizeSpaces(input)).toBe(expected);
  });

  it('should handle multiple nbsp patterns', () => {
    const input = 'Text&nbsp;&nbsp;<span class="Apple-converted-space">&nbsp;</span>more';
    const expected = 'Text   more';
    expect(normalizeSpaces(input)).toBe(expected);
  });
});

describe('normalizeContent', () => {
  it('should normalize plain text quotes only', () => {
    const input = '"Hello" 'world'';
    const expected = '"Hello" \'world\'';
    expect(normalizeContent(input, false)).toBe(expected);
  });

  it('should normalize both quotes and spaces for HTML', () => {
    const input = '"Hello"&nbsp;'world'';
    const expected = '"Hello" \'world\'';
    expect(normalizeContent(input, true)).toBe(expected);
  });
});

describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    const input = '<script>alert("XSS")</script>';
    const output = escapeHtml(input);
    expect(output).toContain('&lt;');
    expect(output).toContain('&gt;');
    expect(output).not.toContain('<script>');
  });

  it('should handle ampersands', () => {
    expect(escapeHtml('A & B')).toContain('&amp;');
  });

  it('should handle empty input', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe(null);
  });
});
