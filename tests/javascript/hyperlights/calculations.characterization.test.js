/**
 * Characterization of resources/js/hyperlights/calculations.js — offset/ID
 * helpers used by the selection→highlight flow. Pinned before .js → .ts.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateCleanTextOffset,
  isNumericalId,
  findContainerWithNumericalId,
} from '../../../resources/js/hyperlights/calculations';

describe('isNumericalId', () => {
  it('accepts integers and dotted decimals, rejects everything else', () => {
    expect(isNumericalId('1')).toBe(true);
    expect(isNumericalId('12.3')).toBe(true);
    expect(isNumericalId('abc')).toBe(false);
    expect(isNumericalId('1.2.3')).toBe(false);
    expect(isNumericalId('')).toBe(false);
    expect(isNumericalId(null)).toBe(false);
  });
});

describe('calculateCleanTextOffset', () => {
  it('returns the HTML-stripped character offset from container start to a point', () => {
    const container = document.createElement('p');
    container.innerHTML = 'Hello <mark>world</mark>';
    const markText = container.querySelector('mark').firstChild; // "world"
    // range = "Hello " + "wor" = 9 clean chars
    expect(calculateCleanTextOffset(container, markText, 3)).toBe(9);
  });
});

describe('findContainerWithNumericalId', () => {
  it('walks up to the nearest block element carrying a numeric id', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="2.1"><span>x</span></p>';
    document.body.appendChild(host);
    const span = host.querySelector('span');
    expect(findContainerWithNumericalId(span).id).toBe('2.1');
    host.remove();
  });

  it('starts from a text node\'s parent and returns null when no numeric block exists', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="notnum">hi</p>';
    document.body.appendChild(host);
    const textNode = host.querySelector('p').firstChild;
    expect(findContainerWithNumericalId(textNode)).toBeNull();
    host.remove();
  });
});
