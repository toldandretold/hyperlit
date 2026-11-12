/**
 * A click inside a body-mounted any-page overlay must not toggle the
 * perimeter buttons — it is not a tap on the page beneath. Before this, a
 * click on the Stats overlay's Tillage summary, padding or a book row hid
 * (or showed) the perimeter buttons behind the dialog.
 */
import { describe, it, expect, afterEach } from 'vitest';
import TogglePerimeterButtons from '../../../resources/js/components/togglePerimeterButtons/togglePerimeterButtons.ts';

const OVERLAYS = [
  'stats-overlay', 'money-overlay', 'notifications-overlay', 'data-sovereignty-overlay',
  'api-tokens-overlay', 'ai-review-viz-overlay', 'harvest-viz-overlay',
];

afterEach(() => { document.body.innerHTML = ''; });

describe('perimeter toggle ignores any-page overlays', () => {
  it.each(OVERLAYS)('a click on non-interactive content inside #%s is ignored', (id) => {
    document.body.innerHTML = `<div id="${id}"><div class="panel"><p class="plain">text</p></div></div>`;
    const t = new TogglePerimeterButtons();
    const target = document.querySelector('.plain');
    expect(t.shouldIgnoreEvent({ target })).toBeTruthy();
  });

  it('positive control: a click on plain page text still toggles', () => {
    document.body.innerHTML = '<main><p class="plain">reading text</p></main>';
    const t = new TogglePerimeterButtons();
    expect(t.shouldIgnoreEvent({ target: document.querySelector('.plain') })).toBeFalsy();
  });
});
