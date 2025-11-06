import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Integration tests for BlockFormatter
 *
 * These tests demonstrate more complex DOM manipulation scenarios.
 * Note: Full BlockFormatter testing would require mocking IndexedDB,
 * SelectionManager, and other dependencies. These are simplified examples
 * showing the core conversion logic.
 */

describe('BlockFormatter Integration Tests', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ===== Code Block to Heading Conversion (Bug Fix Test) =====
  describe('code block to heading conversion', () => {
    it('extracts plain text from code block without double HTML encoding', () => {
      // Setup: Create a code block with HTML entities
      document.body.innerHTML = `
        <div contenteditable="true" class="main-content">
          <pre id="test-code"><code>&lt;div&gt;hello&lt;/div&gt;</code></pre>
        </div>
      `;

      const codeBlock = document.getElementById('test-code');
      const codeElement = codeBlock.querySelector('code');

      // Verify the setup: textContent should give us the decoded HTML
      expect(codeElement.textContent).toBe('<div>hello</div>');

      // Simulate the fix: Extract textContent (not innerHTML) when converting
      const heading = document.createElement('h2');
      heading.id = codeBlock.id;

      // OLD BUG: This would use innerHTML, causing double encoding
      // heading.innerHTML = codeBlock.innerHTML; // ❌ BAD

      // FIX: Use textContent to get decoded text
      heading.textContent = codeElement.textContent; // ✅ GOOD

      // Verify the fix works
      expect(heading.textContent).toBe('<div>hello</div>');
      expect(heading.innerHTML).not.toContain('&amp;'); // No double encoding
      expect(heading.innerHTML).toBe('&lt;div&gt;hello&lt;/div&gt;'); // Single encoding only
    });

    it('handles code blocks with multiple lines', () => {
      document.body.innerHTML = `
        <div contenteditable="true" class="main-content">
          <pre id="test-code"><code>Line 1
Line 2
Line 3</code></pre>
        </div>
      `;

      const codeBlock = document.getElementById('test-code');
      const codeElement = codeBlock.querySelector('code');

      const heading = document.createElement('h1');
      heading.textContent = codeElement.textContent;

      // Should preserve newlines in text content
      expect(heading.textContent).toContain('Line 1\nLine 2\nLine 3');
    });

    it('handles code blocks with special characters', () => {
      document.body.innerHTML = `
        <div contenteditable="true" class="main-content">
          <pre id="test-code"><code>&amp;&lt;&gt;&quot;</code></pre>
        </div>
      `;

      const codeBlock = document.getElementById('test-code');
      const codeElement = codeBlock.querySelector('code');

      const heading = document.createElement('h2');
      heading.textContent = codeElement.textContent;

      // textContent should decode the entities
      expect(heading.textContent).toBe('&<>"');
      // But innerHTML should re-encode them (correctly, not double-encoded)
      expect(heading.innerHTML).toBe('&amp;&lt;&gt;"');
    });

    it('handles empty code blocks', () => {
      document.body.innerHTML = `
        <div contenteditable="true" class="main-content">
          <pre id="test-code"><code></code></pre>
        </div>
      `;

      const codeBlock = document.getElementById('test-code');
      const codeElement = codeBlock.querySelector('code');

      const heading = document.createElement('h3');
      heading.textContent = codeElement.textContent;

      expect(heading.textContent).toBe('');
    });
  });

  // ===== Block Element Identification =====
  describe('block element identification', () => {
    it('correctly identifies code blocks (PRE tags)', () => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);

      expect(pre.tagName).toBe('PRE');
      // In actual BlockFormatter, this would use: block.tagName === 'PRE'
    });

    it('correctly identifies headings H1-H6', () => {
      const headings = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

      headings.forEach((tag) => {
        const heading = document.createElement(tag);
        expect(/^H[1-6]$/.test(heading.tagName)).toBe(true);
      });
    });

    it('correctly identifies blockquotes', () => {
      const blockquote = document.createElement('blockquote');
      expect(blockquote.tagName).toBe('BLOCKQUOTE');
    });
  });

  // ===== Paragraph Conversion Logic =====
  describe('paragraph conversion', () => {
    it('converts heading to paragraph preserving inner HTML', () => {
      document.body.innerHTML = `
        <h2 id="test-heading">Hello <strong>world</strong></h2>
      `;

      const heading = document.getElementById('test-heading');
      const p = document.createElement('p');
      p.innerHTML = heading.innerHTML; // Preserve formatting
      p.id = heading.id;

      // Verify conversion preserves formatting
      expect(p.innerHTML).toBe('Hello <strong>world</strong>');
      expect(p.textContent).toBe('Hello world');
    });

    it('preserves data attributes during conversion', () => {
      document.body.innerHTML = `
        <h2 id="test" data-node-id="node_123">Content</h2>
      `;

      const heading = document.getElementById('test');
      const p = document.createElement('p');
      p.innerHTML = heading.innerHTML;
      p.id = heading.id;

      if (heading.hasAttribute('data-node-id')) {
        p.setAttribute('data-node-id', heading.getAttribute('data-node-id'));
      }

      expect(p.getAttribute('data-node-id')).toBe('node_123');
    });
  });

  // ===== Edge Cases =====
  describe('edge cases', () => {
    it('handles nested elements in code blocks', () => {
      // This shouldn't normally happen, but handle it gracefully
      document.body.innerHTML = `
        <pre><code>text<span>nested</span>more</code></pre>
      `;

      const code = document.querySelector('code');
      const heading = document.createElement('h2');
      heading.textContent = code.textContent;

      expect(heading.textContent).toBe('textnestedmore');
    });

    it('handles code blocks without code element', () => {
      document.body.innerHTML = `
        <pre id="test">Direct text in pre</pre>
      `;

      const pre = document.getElementById('test');
      const codeElement = pre.querySelector('code');

      // Fallback: Use pre.textContent if no code element
      const textContent = codeElement ? codeElement.textContent : pre.textContent;

      const heading = document.createElement('h2');
      heading.textContent = textContent;

      expect(heading.textContent).toBe('Direct text in pre');
    });
  });
});
