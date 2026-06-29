/**
 * Characterization test for the cite-form draft system we are KEEPING through the merge:
 * citeForm/persistence.ts (localStorage key 'formData'). Pins the save→reload round-trip so the
 * merge (which deletes the container's parallel 'newbook-form-data' system) is proven not to
 * regress draft recovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('cite-form draft round-trip (formData key)', () => {
  it('saveFormData writes the title/author to the formData key', () => {
    injectForm();
    document.getElementById('title').value = 'A Theory of Justice';
    document.getElementById('author').value = 'Rawls';

    saveFormData();

    const saved = JSON.parse(localStorage.getItem('formData'));
    expect(saved.title).toBe('A Theory of Justice');
    expect(saved.author).toBe('Rawls');
  });

  it('loadFormData restores fields from a saved draft', () => {
    vi.useFakeTimers();
    localStorage.setItem('formData', JSON.stringify({
      title: 'Capital', author: 'Marx', year: '1867', type: 'book',
    }));
    injectForm();

    loadFormData();
    vi.runOnlyPendingTimers();

    expect(document.getElementById('title').value).toBe('Capital');
    expect(document.getElementById('author').value).toBe('Marx');
    expect(document.getElementById('year').value).toBe('1867');
  });
});
