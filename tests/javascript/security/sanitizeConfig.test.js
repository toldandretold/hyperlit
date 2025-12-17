/**
 * Security Tests: DOMPurify Sanitization Configuration
 *
 * Tests for XSS prevention through the sanitizeConfig module.
 * Verifies that dangerous content is properly sanitized.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sanitizeHtml, SANITIZE_CONFIG } from '../../../resources/js/utilities/sanitizeConfig.js';

// =============================================================================
// SCRIPT TAG REMOVAL TESTS
// =============================================================================

describe('Script Tag XSS Prevention', () => {
  it('removes basic script tags', () => {
    const payload = '<script>alert(1)</script>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('</script>');
    expect(result).not.toContain('alert');
  });

  it('removes script tags with attributes', () => {
    const payload = '<script type="text/javascript" src="evil.js"></script>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<script');
  });

  it('removes script tags with whitespace variations', () => {
    const payloads = [
      '<script >alert(1)</script>',
      '<script\n>alert(1)</script>',
      '<script\t>alert(1)</script>',
      '< script>alert(1)</script>',
    ];

    payloads.forEach(payload => {
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain('<script');
    });
  });

  it('removes script tags with case variations', () => {
    const payloads = [
      '<SCRIPT>alert(1)</SCRIPT>',
      '<ScRiPt>alert(1)</sCrIpT>',
      '<sCRIPT>alert(1)</SCRipt>',
    ];

    payloads.forEach(payload => {
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain('<script');
    });
  });
});

// =============================================================================
// EVENT HANDLER ATTRIBUTE TESTS
// =============================================================================

describe('Event Handler XSS Prevention', () => {
  const eventHandlers = [
    'onclick', 'onerror', 'onload', 'onmouseover', 'onmouseout',
    'onfocus', 'onblur', 'onchange', 'oninput', 'onsubmit',
    'onkeydown', 'onkeyup', 'onkeypress', 'ondrag', 'ondrop',
    'onscroll', 'onresize', 'onwheel', 'oncontextmenu',
  ];

  eventHandlers.forEach(handler => {
    it(`removes ${handler} attribute`, () => {
      const payload = `<div ${handler}="alert(1)">test</div>`;
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain(handler);
    });
  });

  it('removes event handlers with whitespace', () => {
    const payload = '<div onclick = "alert(1)">test</div>';
    const result = sanitizeHtml(payload);
    expect(result.toLowerCase()).not.toContain('onclick');
  });

  it('removes event handlers with different quote styles', () => {
    const payloads = [
      `<div onclick="alert(1)">test</div>`,
      `<div onclick='alert(1)'>test</div>`,
      '<div onclick=alert(1)>test</div>',
    ];

    payloads.forEach(payload => {
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain('onclick');
    });
  });
});

// =============================================================================
// DANGEROUS TAG REMOVAL TESTS
// =============================================================================

describe('Dangerous Tag Removal', () => {
  const dangerousTags = [
    'iframe', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'select', 'textarea',
    'style', 'link', 'meta', 'base',
    'svg', 'math', 'template', 'slot', 'noscript', 'canvas',
  ];

  dangerousTags.forEach(tag => {
    it(`removes <${tag}> tags`, () => {
      const payload = `<${tag}>content</${tag}>`;
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain(`<${tag}`);
    });
  });

  it('removes iframe with src attribute', () => {
    const payload = '<iframe src="https://evil.com"></iframe>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('evil.com');
  });

  it('removes object with data attribute', () => {
    const payload = '<object data="javascript:alert(1)"></object>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<object');
  });

  it('removes embed with src attribute', () => {
    const payload = '<embed src="javascript:alert(1)">';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<embed');
  });
});

// =============================================================================
// SVG XSS VECTORS
// =============================================================================

describe('SVG XSS Prevention', () => {
  it('removes svg tags entirely', () => {
    const payload = '<svg><rect width="100" height="100"/></svg>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<svg');
  });

  it('removes svg with embedded script', () => {
    const payload = '<svg><script>alert(1)</script></svg>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('<script');
  });

  it('removes svg with onload handler', () => {
    const payload = '<svg onload="alert(1)"><rect/></svg>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('onload');
  });

  it('removes svg foreignObject attacks', () => {
    const payload = `
      <svg>
        <foreignObject>
          <body xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)">
            <script>alert(document.cookie)</script>
          </body>
        </foreignObject>
      </svg>
    `;
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('foreignObject');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('onload');
  });

  it('removes svg use element xss', () => {
    const payload = '<svg><use xlink:href="data:image/svg+xml,<svg onload=alert(1)>"/></svg>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('onload');
  });
});

// =============================================================================
// JAVASCRIPT URL SANITIZATION
// =============================================================================

describe('JavaScript URL Sanitization', () => {
  it('removes javascript: URLs from href', () => {
    const payload = '<a href="javascript:alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('javascript:');
  });

  it('removes javascript: with case variations', () => {
    const payloads = [
      '<a href="JAVASCRIPT:alert(1)">click</a>',
      '<a href="JaVaScRiPt:alert(1)">click</a>',
      '<a href="jAvAsCrIpT:alert(1)">click</a>',
    ];

    payloads.forEach(payload => {
      const result = sanitizeHtml(payload);
      expect(result.toLowerCase()).not.toContain('javascript:');
    });
  });

  it('removes javascript: with leading whitespace', () => {
    const payload = '<a href="  javascript:alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result.toLowerCase()).not.toContain('javascript:');
  });

  it('removes vbscript: URLs', () => {
    const payload = '<a href="vbscript:msgbox(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result.toLowerCase()).not.toContain('vbscript:');
  });

  it('removes javascript: from src attribute', () => {
    const payload = '<img src="javascript:alert(1)">';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('javascript:');
  });
});

// =============================================================================
// DATA URI SANITIZATION
// =============================================================================

describe('Data URI Sanitization', () => {
  it('removes data:text/html URIs', () => {
    const payload = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('data:text/html');
  });

  it('removes data:application URIs', () => {
    const payload = '<a href="data:application/javascript,alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('data:application');
  });

  it('allows data:image URIs (for legitimate images)', () => {
    // This might be allowed for base64 images
    const payload = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    const result = sanitizeHtml(payload);
    // data:image should typically be allowed
  });
});

// =============================================================================
// STYLE ATTRIBUTE SANITIZATION
// =============================================================================

describe('Style Attribute Sanitization', () => {
  it('blocks expression() in styles', () => {
    const payload = '<div style="width: expression(alert(1))">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('expression');
  });

  it('blocks url() with javascript', () => {
    const payload = '<div style="background: url(javascript:alert(1))">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('javascript');
  });

  it('blocks -moz-binding', () => {
    const payload = '<div style="-moz-binding: url(evil.xml)">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('-moz-binding');
  });

  it('blocks behavior: property', () => {
    const payload = '<div style="behavior: url(evil.htc)">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('behavior');
  });

  it('blocks @import in styles', () => {
    const payload = '<div style="@import url(evil.css)">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('@import');
  });

  it('allows safe CSS properties', () => {
    const payload = '<div style="color: red; font-size: 14px;">test</div>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('style=');
    expect(result).toContain('color');
  });
});

// =============================================================================
// FORM ELEMENT REMOVAL
// =============================================================================

describe('Form Element Removal', () => {
  it('removes form tags', () => {
    const payload = '<form action="https://evil.com"><input type="text"></form>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
  });

  it('removes button elements', () => {
    const payload = '<button onclick="submit()">Click</button>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<button');
  });

  it('removes select elements', () => {
    const payload = '<select><option>Choose</option></select>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<select');
  });

  it('removes textarea elements', () => {
    const payload = '<textarea>Enter text</textarea>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<textarea');
  });
});

// =============================================================================
// DATA ATTRIBUTE HANDLING
// =============================================================================

describe('Data Attribute Handling', () => {
  it('allows standard data-* attributes', () => {
    const payload = '<div data-id="123" data-value="test">content</div>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('data-id');
    expect(result).toContain('data-value');
  });

  it('allows publisher-specific attributes', () => {
    const payload = '<div content-id="123" reveal-id="456">content</div>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('content-id');
    expect(result).toContain('reveal-id');
  });

  it('data attributes cannot contain XSS payloads that execute', () => {
    // Data attributes themselves don't execute, but test the pattern
    const payload = '<div data-payload="<script>alert(1)</script>">test</div>';
    const result = sanitizeHtml(payload);
    // The data attribute value should be entity-encoded or the content stripped
    expect(result).not.toMatch(/<script>alert\(1\)<\/script>/i);
  });
});

// =============================================================================
// ENCODING BYPASS ATTEMPTS
// =============================================================================

describe('Encoding Bypass Prevention', () => {
  it('handles HTML entity encoded script tags', () => {
    const payload = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const result = sanitizeHtml(payload);
    // Entity-encoded content should remain as text, not execute
    expect(result).not.toContain('<script>');
  });

  it('handles hex-encoded characters', () => {
    const payload = '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;:alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    // Should decode and block
    expect(result.toLowerCase()).not.toContain('javascript');
  });

  it('handles decimal-encoded characters', () => {
    const payload = '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result.toLowerCase()).not.toContain('javascript');
  });

  it('handles mixed encoding', () => {
    const payload = '<a href="java&#x73;cript:alert(1)">click</a>';
    const result = sanitizeHtml(payload);
    expect(result.toLowerCase()).not.toContain('javascript');
  });
});

// =============================================================================
// CONTENT PRESERVATION
// =============================================================================

describe('Safe Content Preservation', () => {
  it('preserves safe HTML elements', () => {
    const payload = '<p>Hello <strong>world</strong></p>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('<p>');
    expect(result).toContain('<strong>');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('preserves links with safe URLs', () => {
    const payload = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('<a');
    expect(result).toContain('https://example.com');
  });

  it('preserves images with safe sources', () => {
    const payload = '<img src="https://example.com/image.png" alt="test">';
    const result = sanitizeHtml(payload);
    expect(result).toContain('<img');
    expect(result).toContain('src=');
  });

  it('preserves list elements', () => {
    const payload = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
  });

  it('preserves table elements', () => {
    const payload = '<table><tr><td>Cell</td></tr></table>';
    const result = sanitizeHtml(payload);
    expect(result).toContain('<table>');
    expect(result).toContain('<tr>');
    expect(result).toContain('<td>');
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  it('handles empty string', () => {
    const result = sanitizeHtml('');
    expect(result).toBe('');
  });

  it('handles null input', () => {
    const result = sanitizeHtml(null);
    expect(result).toBe('');
  });

  it('handles undefined input', () => {
    const result = sanitizeHtml(undefined);
    expect(result).toBe('');
  });

  it('handles very long input', () => {
    const longContent = 'a'.repeat(100000);
    const result = sanitizeHtml(`<p>${longContent}</p>`);
    expect(result).toContain(longContent);
  });

  it('handles nested malicious content', () => {
    const payload = '<div><p><span onclick="alert(1)"><a href="javascript:alert(2)">text</a></span></p></div>';
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('javascript:');
  });

  it('handles multiple XSS vectors in one string', () => {
    const payload = `
      <script>alert(1)</script>
      <img src=x onerror=alert(2)>
      <a href="javascript:alert(3)">click</a>
      <div onclick="alert(4)">hover</div>
    `;
    const result = sanitizeHtml(payload);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('onclick');
  });
});

// =============================================================================
// CONFIGURATION TESTS
// =============================================================================

describe('Sanitize Configuration', () => {
  it('exports FORBID_TAGS array', () => {
    expect(SANITIZE_CONFIG.FORBID_TAGS).toBeDefined();
    expect(Array.isArray(SANITIZE_CONFIG.FORBID_TAGS)).toBe(true);
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain('script');
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain('iframe');
  });

  it('exports FORBID_ATTR array', () => {
    expect(SANITIZE_CONFIG.FORBID_ATTR).toBeDefined();
    expect(Array.isArray(SANITIZE_CONFIG.FORBID_ATTR)).toBe(true);
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('onclick');
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('onerror');
  });

  it('exports ADD_ATTR for publisher attributes', () => {
    expect(SANITIZE_CONFIG.ADD_ATTR).toBeDefined();
    expect(Array.isArray(SANITIZE_CONFIG.ADD_ATTR)).toBe(true);
    expect(SANITIZE_CONFIG.ADD_ATTR).toContain('content-id');
  });

  it('has ALLOW_DATA_ATTR enabled', () => {
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(true);
  });

  it('has KEEP_CONTENT enabled', () => {
    expect(SANITIZE_CONFIG.KEEP_CONTENT).toBe(true);
  });
});
