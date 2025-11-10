/**
 * YouTube Transcript Detection and Transformation
 *
 * Detects if pasted content is a YouTube transcript and transforms it
 * into readable paragraphs by removing timestamps and grouping sentences.
 */

/**
 * Detect if pasted text is a YouTube transcript
 * Checks both HTML structure and plainText patterns
 * @param {string} plainText - Plain text content
 * @param {string} rawHtml - HTML content
 * @returns {Object} - { isYouTube: boolean, source: 'html'|'plaintext'|null }
 */
export function detectYouTubeTranscript(plainText, rawHtml) {
  // First check HTML for YouTube transcript classes
  if (rawHtml && typeof rawHtml === 'string') {
    const hasYouTubeClasses =
      rawHtml.includes('ytd-transcript-segment-renderer') ||
      rawHtml.includes('segment-timestamp') ||
      (rawHtml.includes('yt-formatted-string') && rawHtml.includes('segment-text'));

    if (hasYouTubeClasses) {
      return { isYouTube: true, source: 'html' };
    }
  }

  // Fallback to plainText pattern detection
  if (!plainText || typeof plainText !== 'string') {
    return { isYouTube: false, source: null };
  }

  const lines = plainText.split('\n');
  let timestampCount = 0;

  // Check first 20 lines for timestamp patterns
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i].trim();
    // Match timestamp patterns: 8:59, 1:23:45, etc. (on their own line OR at start of line)
    if (/^\d{1,2}:\d{2}(:\d{2})?($|\s)/.test(line)) {
      timestampCount++;
    }
  }

  // If we find 3+ timestamps in the first 20 lines, it's likely a transcript
  if (timestampCount >= 3) {
    return { isYouTube: true, source: 'plaintext' };
  }

  return { isYouTube: false, source: null };
}

/**
 * Transform YouTube transcript into readable paragraphs
 * Removes timestamps and groups sentences
 * @param {string} plainText - Plain text transcript
 * @param {string} rawHtml - HTML transcript
 * @param {string} source - Detection source ('html' or 'plaintext')
 * @returns {string} - Transformed text ready for markdown conversion
 */
export function transformYouTubeTranscript(plainText, rawHtml, source) {
  let extractedText = '';

  if (source === 'html' && rawHtml) {
    // Parse HTML and extract text from transcript segments
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Extract text from yt-formatted-string elements (the actual transcript text)
    const textElements = doc.querySelectorAll('.segment-text, yt-formatted-string.segment-text');
    const textParts = [];

    textElements.forEach(el => {
      const text = el.textContent.trim();
      if (text && !text.match(/^\d{1,2}:\d{2}/)) { // Skip timestamps
        textParts.push(text);
      }
    });

    extractedText = textParts.join(' ');
  } else {
    // Use plainText
    const lines = plainText.split('\n');
    const textLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip timestamp lines (standalone or at start of line)
      if (/^\d{1,2}:\d{2}(:\d{2})?($|\s)/.test(line)) {
        // If timestamp is at start, keep the rest of the line
        const afterTimestamp = line.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '').trim();
        if (afterTimestamp) {
          textLines.push(afterTimestamp);
        }
        continue;
      }

      // Remove leading dash/bullet and add to text
      const cleaned = line.replace(/^[-•]\s*/, '').trim();
      if (cleaned) {
        textLines.push(cleaned);
      }
    }

    extractedText = textLines.join(' ');
  }

  // Split into sentences (ending with . ! ?)
  const sentences = extractedText.match(/[^.!?]+[.!?]+/g) || [extractedText];

  // Group sentences into paragraphs (3-4 sentences each)
  const paragraphs = [];
  const sentencesPerParagraph = 3;

  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    const paragraphSentences = sentences.slice(i, i + sentencesPerParagraph);
    paragraphs.push(paragraphSentences.join(' ').trim());
  }

  // Join paragraphs with double newlines for markdown parsing
  return paragraphs.join('\n\n');
}
