/**
 * Captured console arguments must survive into a glitch report.
 *
 * `JSON.stringify(new Error('boom'))` is `"{}"` — message and stack are
 * non-enumerable. So every captured error in every paste glitch report used to
 * arrive as a bare `{}`, discarding the actual failure. Prod case
 * book_1787965215968 reported: "❌ Failed to sync references to PostgreSQL: {}".
 */

import { describe, it, expect } from 'vitest';
import { describeLogArgument } from '../../../resources/js/integrity/logCapture';

describe('describeLogArgument', () => {
  it('keeps the message of an Error instead of flattening it to {}', () => {
    const described = describeLogArgument(new Error('HTTP 500: Internal Server Error'));

    expect(described).not.toBe('{}');
    expect(described).toContain('HTTP 500: Internal Server Error');
    expect(described).toContain('Error');
  });

  it('keeps the subclass name', () => {
    class SyncError extends Error {}
    const err = new SyncError('rls rejected the insert');
    err.name = 'SyncError';

    expect(describeLogArgument(err)).toContain('SyncError: rls rejected the insert');
  });

  it('recognises a cross-realm error by shape', () => {
    const foreign = { name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x is not a function\n  at y' };

    expect(describeLogArgument(foreign)).toContain('TypeError: x is not a function');
  });

  it('keeps an Error nested inside a logged object', () => {
    const described = describeLogArgument({ book: 'book_1', cause: new Error('boom') });

    expect(described).toContain('book_1');
    expect(described).toContain('boom');
  });

  it('still serializes ordinary objects as JSON', () => {
    expect(describeLogArgument({ book: 'book_1', count: 54 })).toBe('{"book":"book_1","count":54}');
  });

  it('does not blow up on a circular object', () => {
    const circular = { name: 'loop' };
    circular.self = circular;

    expect(() => describeLogArgument(circular)).not.toThrow();
    expect(describeLogArgument(circular)).toContain('loop');
  });

  it('passes primitives through', () => {
    expect(describeLogArgument('plain')).toBe('plain');
    expect(describeLogArgument(54)).toBe('54');
    expect(describeLogArgument(null)).toBe('null');
    expect(describeLogArgument(undefined)).toBe('undefined');
  });
});
