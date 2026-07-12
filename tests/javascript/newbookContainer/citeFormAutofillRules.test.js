/**
 * Autofill must never write a value the cite-form's own rules reject — the
 * bug this locks down: dropping a PDF whose CreationDate parsed to "0000"
 * autofilled #year with a value below the input's min="1000", leaving the
 * submit blocked by native validation the user couldn't see past.
 *
 * autofillRules.ts is the single source of truth for the year bounds (input
 * min/max in template.ts, validateYear in validation.ts) and for the
 * sanitizers every autofill path (PDF metadata, file metadata, BibTeX parse,
 * search selection) runs values through.
 */
import { describe, it, expect } from 'vitest';
import {
  YEAR_MIN,
  yearMax,
  isValidYear,
  sanitizeYearForAutofill,
  sanitizeTitleForAutofill,
  TITLE_MAX_LENGTH,
} from '../../../resources/js/components/newbookContainer/citeForm/autofillRules';
import { getCiteFormHTML } from '../../../resources/js/components/newbookContainer/citeForm/template';

describe('sanitizeYearForAutofill', () => {
  it('rejects the "0000" PDF CreationDate year (the reported bug)', () => {
    expect(sanitizeYearForAutofill('0000')).toBe('');
  });

  it('rejects years below the form minimum', () => {
    expect(sanitizeYearForAutofill('0999')).toBe('');
    expect(sanitizeYearForAutofill('42')).toBe('');
  });

  it('rejects years above the form maximum', () => {
    expect(sanitizeYearForAutofill(String(yearMax() + 1))).toBe('');
    expect(sanitizeYearForAutofill('20244')).toBe('');
  });

  it('rejects non-numeric garbage', () => {
    expect(sanitizeYearForAutofill('n.d.')).toBe('');
    expect(sanitizeYearForAutofill(null)).toBe('');
    expect(sanitizeYearForAutofill(undefined)).toBe('');
    expect(sanitizeYearForAutofill('')).toBe('');
  });

  it('passes valid years through, trimmed', () => {
    expect(sanitizeYearForAutofill('1984')).toBe('1984');
    expect(sanitizeYearForAutofill(' 2020 ')).toBe('2020');
    expect(sanitizeYearForAutofill(String(YEAR_MIN))).toBe(String(YEAR_MIN));
    expect(sanitizeYearForAutofill(String(yearMax()))).toBe(String(yearMax()));
  });
});

describe('sanitizeTitleForAutofill', () => {
  it('clamps titles to the form max length', () => {
    const long = 'x'.repeat(TITLE_MAX_LENGTH + 50);
    expect(sanitizeTitleForAutofill(long)).toHaveLength(TITLE_MAX_LENGTH);
  });

  it('trims and stringifies safely', () => {
    expect(sanitizeTitleForAutofill('  A Title  ')).toBe('A Title');
    expect(sanitizeTitleForAutofill(undefined)).toBe('');
  });
});

describe('the #year input and the sanitizer agree on the bounds', () => {
  it('template min/max match YEAR_MIN/yearMax()', () => {
    const meta = document.querySelector('meta[name="csrf-token"]') || document.createElement('meta');
    meta.name = 'csrf-token';
    meta.setAttribute('content', 'test-token');
    if (!meta.parentNode) document.head.appendChild(meta);

    document.body.innerHTML = getCiteFormHTML();
    const yearInput = document.getElementById('year');
    expect(yearInput.min).toBe(String(YEAR_MIN));
    expect(yearInput.max).toBe(String(yearMax()));

    // Anything the sanitizer lets through satisfies the input's constraints.
    yearInput.value = sanitizeYearForAutofill('1984');
    expect(yearInput.checkValidity()).toBe(true);
    document.body.innerHTML = '';
  });

  it('isValidYear brackets exactly [YEAR_MIN, yearMax()]', () => {
    expect(isValidYear(YEAR_MIN - 1)).toBe(false);
    expect(isValidYear(YEAR_MIN)).toBe(true);
    expect(isValidYear(yearMax())).toBe(true);
    expect(isValidYear(yearMax() + 1)).toBe(false);
  });
});
