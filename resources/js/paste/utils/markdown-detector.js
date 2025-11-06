/**
 * Markdown Detection Utility
 * Detects if pasted text contains Markdown formatting
 *
 * Features:
 * - Pattern-based detection (headers, bold, italic, lists, etc.)
 * - Threshold-based matching (requires at least 1 pattern match)
 * - Debug logging for pattern analysis
 */

/**
 * Detect if text contains Markdown formatting
 * Uses pattern matching to identify common Markdown syntax
 *
 * @param {string} text - Text to analyze
 * @returns {boolean} - True if Markdown detected, false otherwise
 */
export function detectMarkdown(text) {
  if (!text || typeof text !== 'string') return false;

  console.log('detectMarkdown input:');

  const markdownPatterns = [
    /^#{1,6}\s+/m,                    // Headers
    /\*{1,2}[^*\n]+\*{1,2}/,         // Bold/italic (removed ^ anchor)
    /_{1,2}[^_\n]+_{1,2}/,           // Bold/italic with underscores
    /^\* /m,                         // Unordered lists
    /^\d+\. /m,                      // Ordered lists
    /^\> /m,                         // Blockquotes
    /`[^`]+`/,                       // Inline code (actual backticks only)
    /^```/m,                         // Code blocks
    /\[.+\]\(.+\)/,                  // Links (removed ^ anchor)
    /^!\[.*\]\(.+\)/m,               // Images
    /^\|.+\|/m,                      // Tables
    /^---+$/m,                       // Horizontal rules
    /^\- \[[ x]\]/m                  // Task lists
  ];

  // Count how many patterns match and log each one
  const matches = markdownPatterns.filter((pattern, index) => {
    const match = pattern.test(text);
    console.log(`Pattern ${index} (${pattern}):`, match);
    // Special debug for inline code pattern
    if (index === 6 && match) {
      const codeMatch = text.match(pattern);
      console.log(`🔍 Inline code match found:`, codeMatch);
    }
    return match;
  });

  console.log('Total matches:', matches.length);

  // Change this line: lower threshold to 1
  return matches.length >= 1;
}
