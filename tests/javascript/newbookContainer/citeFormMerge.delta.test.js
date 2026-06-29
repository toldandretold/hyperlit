/**
 * Tests for the three INTENDED behaviour changes introduced by merging the container's
 * redundant field-toggle + draft systems into citeForm:
 *   1. `book` type still reveals the `pages` field (kept on purpose via showFieldsForType).
 *   2. The single draft system writes only the 'formData' key (the parallel 'newbook-form-data'
 *      system is gone).
 *   3. `_token` (CSRF) is no longer persisted in the draft (was a latent stale-token bug).
 * Plus: the ported file-restore note still renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showFieldsForType } from '../../../resources/js/components/newbookContainer/citeForm/fields';
import { saveFormData, loadFormData } from '../../../resources/js/components/newbookContainer/citeForm/persistence';
import { getCiteFormHTML } from '../../../resources/js/components/newbookContainer/citeForm/template';

function injectForm() {
  document.body.innerHTML = '';
  const meta = document.querySelector('meta[name="csrf-token"]') || document.createElement('meta');
  meta.name = 'csrf-token';
  meta.setAttribute('content', 'test-token');
  if (!meta.parentNode) document.head.appendChild(meta);

  const container = document.createElement('div');
  container.id = 'newbook-container';
  container.innerHTML = getCiteFormHTML();
  document.body.appendChild(container);
  return container;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('delta 1: pages stays available for book type', () => {
  it("showFieldsForType('book') reveals the pages field + label", () => {
    injectForm();
    showFieldsForType('book');

    expect(document.getElementById('pages').style.display).toBe('block');
    expect(document.querySelector('label[for="pages"]').style.display).toBe('block');
    // publisher (the original book field) is still shown too
    expect(document.getElementById('publisher').style.display).toBe('block');
  });

  it('phdthesis still does NOT show pages (other types unchanged)', () => {
    injectForm();
    showFieldsForType('phdthesis');
    expect(document.getElementById('pages').style.display).toBe('none');
    expect(document.getElementById('school').style.display).toBe('block');
  });
});

describe('delta 2 + 3: single draft system, no _token', () => {
  it('saveFormData writes only the formData key (not newbook-form-data) and never persists _token', () => {
    injectForm();
    document.getElementById('title').value = 'Grundrisse';

    saveFormData();

    expect(localStorage.getItem('formData')).not.toBeNull();
    expect(localStorage.getItem('newbook-form-data')).toBeNull();
    const saved = JSON.parse(localStorage.getItem('formData'));
    expect('_token' in saved).toBe(false);
  });
});

describe('ported feature: file-restore note', () => {
  it('renders the "please reselect" note when a filename was saved', () => {
    vi.useFakeTimers();
    localStorage.setItem('formData', JSON.stringify({
      title: 'X', selectedFileName: 'thesis.pdf',
    }));
    injectForm();

    loadFormData();
    vi.runOnlyPendingTimers();

    const note = document.getElementById('file-restore-note');
    expect(note).toBeTruthy();
    expect(note.textContent).toContain('thesis.pdf');
  });
});
