import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasParentWithTag,
  findParentWithTag,
  isBlockElement,
  getBlockElementsInRange,
  selectAcrossElements,
  getElementsInSelectionRange,
  findClosestBlockParent,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  getLastTextNode,
  getFirstTextNode,
  findClosestListItem,
} from '../../../resources/js/editToolbar/toolbarDOMUtils.js';

describe('toolbarDOMUtils', () => {
  beforeEach(() => {
    // Clear document body before each test
    document.body.innerHTML = '';
  });

  // ===== hasParentWithTag =====
  describe('hasParentWithTag', () => {
    it('returns true when element IS the target tag', () => {
      const strong = document.createElement('strong');
      expect(hasParentWithTag(strong, 'STRONG')).toBe(true);
    });

    it('returns true when parent has the target tag', () => {
      const div = document.createElement('div');
      const strong = document.createElement('strong');
      const span = document.createElement('span');
      div.appendChild(strong);
      strong.appendChild(span);

      expect(hasParentWithTag(span, 'STRONG')).toBe(true);
    });

    it('returns true when grandparent has the target tag', () => {
      const strong = document.createElement('strong');
      const em = document.createElement('em');
      const span = document.createElement('span');
      strong.appendChild(em);
      em.appendChild(span);

      expect(hasParentWithTag(span, 'STRONG')).toBe(true);
    });

    it('returns false when neither element nor parents have the tag', () => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      div.appendChild(span);

      expect(hasParentWithTag(span, 'STRONG')).toBe(false);
    });

    it('returns false for null element', () => {
      expect(hasParentWithTag(null, 'STRONG')).toBe(false);
    });

    it('is case-sensitive (requires uppercase tag names)', () => {
      const strong = document.createElement('strong');
      expect(hasParentWithTag(strong, 'strong')).toBe(false);
      expect(hasParentWithTag(strong, 'STRONG')).toBe(true);
    });
  });

  // ===== findParentWithTag =====
  describe('findParentWithTag', () => {
    it('returns the element itself if it matches the tag', () => {
      const strong = document.createElement('strong');
      expect(findParentWithTag(strong, 'STRONG')).toBe(strong);
    });

    it('returns parent element when parent matches', () => {
      const div = document.createElement('div');
      const strong = document.createElement('strong');
      const span = document.createElement('span');
      div.appendChild(strong);
      strong.appendChild(span);

      expect(findParentWithTag(span, 'STRONG')).toBe(strong);
    });

    it('returns null when no match found', () => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      div.appendChild(span);

      expect(findParentWithTag(span, 'STRONG')).toBe(null);
    });

    it('returns null for null element', () => {
      expect(findParentWithTag(null, 'STRONG')).toBe(null);
    });
  });

  // ===== isBlockElement =====
  describe('isBlockElement', () => {
    it('returns true for paragraph element', () => {
      const p = document.createElement('p');
      expect(isBlockElement(p)).toBe(true);
    });

    it('returns true for all heading levels', () => {
      const h1 = document.createElement('h1');
      const h2 = document.createElement('h2');
      const h3 = document.createElement('h3');
      const h4 = document.createElement('h4');
      const h5 = document.createElement('h5');
      const h6 = document.createElement('h6');

      expect(isBlockElement(h1)).toBe(true);
      expect(isBlockElement(h2)).toBe(true);
      expect(isBlockElement(h3)).toBe(true);
      expect(isBlockElement(h4)).toBe(true);
      expect(isBlockElement(h5)).toBe(true);
      expect(isBlockElement(h6)).toBe(true);
    });

    it('returns true for blockquote and pre', () => {
      const blockquote = document.createElement('blockquote');
      const pre = document.createElement('pre');

      expect(isBlockElement(blockquote)).toBe(true);
      expect(isBlockElement(pre)).toBe(true);
    });

    it('returns true for list elements', () => {
      const ul = document.createElement('ul');
      const ol = document.createElement('ol');
      const li = document.createElement('li');

      expect(isBlockElement(ul)).toBe(true);
      expect(isBlockElement(ol)).toBe(true);
      expect(isBlockElement(li)).toBe(true);
    });

    it('returns true for semantic elements', () => {
      const section = document.createElement('section');
      const article = document.createElement('article');
      const header = document.createElement('header');
      const footer = document.createElement('footer');
      const main = document.createElement('main');
      const nav = document.createElement('nav');

      expect(isBlockElement(section)).toBe(true);
      expect(isBlockElement(article)).toBe(true);
      expect(isBlockElement(header)).toBe(true);
      expect(isBlockElement(footer)).toBe(true);
      expect(isBlockElement(main)).toBe(true);
      expect(isBlockElement(nav)).toBe(true);
    });

    it('returns false for inline elements', () => {
      const strong = document.createElement('strong');
      const em = document.createElement('em');
      const span = document.createElement('span');
      const a = document.createElement('a');

      expect(isBlockElement(strong)).toBe(false);
      expect(isBlockElement(em)).toBe(false);
      expect(isBlockElement(span)).toBe(false);
      expect(isBlockElement(a)).toBe(false);
    });

    it('returns false for text nodes', () => {
      const textNode = document.createTextNode('hello');
      expect(isBlockElement(textNode)).toBe(false);
    });

    it('returns false for null or undefined', () => {
      expect(isBlockElement(null)).toBe(false);
      expect(isBlockElement(undefined)).toBe(false);
    });
  });

  // ===== findClosestBlockParent =====
  describe('findClosestBlockParent', () => {
    it('returns the element itself if it is a block element', () => {
      const p = document.createElement('p');
      expect(findClosestBlockParent(p)).toBe(p);
    });

    it('returns parent when parent is a block element', () => {
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      p.appendChild(strong);

      expect(findClosestBlockParent(strong)).toBe(p);
    });

    it('walks up multiple levels to find block parent', () => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      div.appendChild(span);
      span.appendChild(strong);

      expect(findClosestBlockParent(strong)).toBe(div);
    });

    it('returns null for null element', () => {
      expect(findClosestBlockParent(null)).toBe(null);
    });

    it('returns null when no block parent exists', () => {
      const span = document.createElement('span');
      // Not in document, no block parent
      expect(findClosestBlockParent(span)).toBe(null);
    });
  });

  // ===== getLastTextNode =====
  describe('getLastTextNode', () => {
    it('returns last text node in simple element', () => {
      const div = document.createElement('div');
      div.innerHTML = 'First text<br>Last text';

      const lastTextNode = getLastTextNode(div);
      expect(lastTextNode?.textContent).toBe('Last text');
    });

    it('returns text node inside nested elements', () => {
      const div = document.createElement('div');
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = 'nested text';
      p.appendChild(strong);
      div.appendChild(p);

      const lastTextNode = getLastTextNode(div);
      expect(lastTextNode?.textContent).toBe('nested text');
    });

    it('returns null for element with no text nodes', () => {
      const div = document.createElement('div');
      const br = document.createElement('br');
      div.appendChild(br);

      expect(getLastTextNode(div)).toBe(null);
    });
  });

  // ===== getFirstTextNode =====
  describe('getFirstTextNode', () => {
    it('returns first text node in simple element', () => {
      const div = document.createElement('div');
      div.innerHTML = 'First text<br>Last text';

      const firstTextNode = getFirstTextNode(div);
      expect(firstTextNode?.textContent).toBe('First text');
    });

    it('returns first text node even if nested', () => {
      const div = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = 'bold text';
      const span = document.createElement('span');
      span.textContent = 'span text';
      div.appendChild(strong);
      div.appendChild(span);

      const firstTextNode = getFirstTextNode(div);
      expect(firstTextNode?.textContent).toBe('bold text');
    });

    it('returns null for element with no text nodes', () => {
      const div = document.createElement('div');
      expect(getFirstTextNode(div)).toBe(null);
    });
  });

  // ===== findClosestListItem =====
  describe('findClosestListItem', () => {
    it('returns the element itself if it is an LI', () => {
      const li = document.createElement('li');
      expect(findClosestListItem(li)).toBe(li);
    });

    it('returns parent LI when called from child element', () => {
      const ul = document.createElement('ul');
      const li = document.createElement('li');
      const span = document.createElement('span');
      ul.appendChild(li);
      li.appendChild(span);
      document.body.appendChild(ul);

      expect(findClosestListItem(span)).toBe(li);
    });

    it('returns null when no LI ancestor exists', () => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      div.appendChild(span);
      document.body.appendChild(div);

      expect(findClosestListItem(span)).toBe(null);
    });

    it('returns null for null element', () => {
      expect(findClosestListItem(null)).toBe(null);
    });

    it('stops at document.body', () => {
      const span = document.createElement('span');
      document.body.appendChild(span);

      expect(findClosestListItem(span)).toBe(null);
    });
  });

  // ===== getTextOffsetInElement =====
  describe('getTextOffsetInElement', () => {
    it('returns 0 when container is at start of element', () => {
      const div = document.createElement('div');
      div.textContent = 'Hello world';
      const textNode = div.firstChild;

      const offset = getTextOffsetInElement(div, textNode, 0);
      expect(offset).toBe(0);
    });

    it('returns correct offset in middle of text', () => {
      const div = document.createElement('div');
      div.textContent = 'Hello world';
      const textNode = div.firstChild;

      const offset = getTextOffsetInElement(div, textNode, 5);
      expect(offset).toBe(5); // After "Hello"
    });

    it('handles nested elements correctly', () => {
      const div = document.createElement('div');
      div.innerHTML = 'Start <strong>bold</strong> end';
      const boldElement = div.querySelector('strong');
      const boldTextNode = boldElement.firstChild;

      const offset = getTextOffsetInElement(div, boldTextNode, 2);
      expect(offset).toBe(8); // "Start " (6) + "bo" (2)
    });

    it('returns 0 for null inputs', () => {
      expect(getTextOffsetInElement(null, null, 0)).toBe(0);
    });
  });

  // Note: selectAcrossElements, setCursorAtTextOffset, and getBlockElementsInRange
  // require more complex Range/Selection mocking which would make tests longer
  // For now, we've covered the pure utility functions comprehensively
});
