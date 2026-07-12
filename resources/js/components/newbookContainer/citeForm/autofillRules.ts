// Single source of truth for the cite-form field rules that BOTH validation
// and autofill must agree on. Every autofill path (PDF metadata, file
// metadata, BibTeX parse, search selection) runs its value through these
// sanitizers before writing to an input — autofill must never write a value
// the form itself rejects (e.g. "0000" scraped from a PDF CreationDate),
// which strands the user behind native <input> min/max validation.

export const YEAR_MIN = 1000;

export function yearMax(): number {
  return new Date().getFullYear() + 10;
}

export function isValidYear(value: string | number): boolean {
  const year = parseInt(String(value), 10);
  return Number.isFinite(year) && year >= YEAR_MIN && year <= yearMax();
}

/** The year if it passes the form rules, else '' (autofill skips the field). */
export function sanitizeYearForAutofill(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return isValidYear(value) ? value : '';
}

export const TITLE_MAX_LENGTH = 255;

/** Trimmed title clamped to the form's max length (over-long metadata titles
 *  would otherwise autofill a value validateTitle rejects). */
export function sanitizeTitleForAutofill(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, TITLE_MAX_LENGTH);
}
