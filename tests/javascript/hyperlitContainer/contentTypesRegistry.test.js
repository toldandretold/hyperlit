/**
 * Registry completeness + priority drift gate. Asserts all five content types are
 * registered with the documented priorities and that the priority sort yields the
 * canonical order. Cheap guard against a handler being dropped or mis-prioritised.
 */
import { describe, it, expect } from 'vitest';

import {
  CONTENT_TYPE_HANDLERS,
  getHandler,
  priorityOf,
} from '../../../resources/js/hyperlitContainer/contentTypes/registry';

describe('content-type registry', () => {
  it('registers exactly the five known content types', () => {
    const types = CONTENT_TYPE_HANDLERS.map((h) => h.type).sort();
    expect(types).toEqual(
      ['citation', 'footnote', 'highlight', 'hypercite', 'hypercite-citation'],
    );
  });

  it('every handler exposes a buildContent and a numeric priority', () => {
    for (const h of CONTENT_TYPE_HANDLERS) {
      expect(typeof h.buildContent).toBe('function');
      expect(typeof h.priority).toBe('number');
    }
  });

  it('priorities match the documented order', () => {
    expect(priorityOf('hypercite-citation')).toBe(1);
    expect(priorityOf('footnote')).toBe(2);
    expect(priorityOf('citation')).toBe(3);
    expect(priorityOf('hypercite')).toBe(4);
    expect(priorityOf('highlight')).toBe(5);
  });

  it('an unknown type sorts last (priority 999)', () => {
    expect(priorityOf('nope')).toBe(999);
    expect(getHandler('nope')).toBeUndefined();
  });

  it('sorting a shuffled set by priority yields the canonical order', () => {
    const shuffled = ['highlight', 'footnote', 'citation', 'hypercite', 'hypercite-citation'];
    const sorted = [...shuffled].sort((a, b) => priorityOf(a) - priorityOf(b));
    expect(sorted).toEqual(
      ['hypercite-citation', 'footnote', 'citation', 'hypercite', 'highlight'],
    );
  });

  it('only the editable types carry a checkPermission; only timestamped types carry fetchTimestamp', () => {
    expect(typeof getHandler('footnote').checkPermission).toBe('function');
    expect(typeof getHandler('highlight').checkPermission).toBe('function');
    expect(getHandler('citation').checkPermission).toBeUndefined();
    expect(typeof getHandler('highlight').fetchTimestamp).toBe('function');
    expect(typeof getHandler('hypercite').fetchTimestamp).toBe('function');
    expect(getHandler('footnote').fetchTimestamp).toBeUndefined();
  });
});
