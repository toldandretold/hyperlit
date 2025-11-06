/**
 * URL Detection and Conversion Utility
 * Detects URLs in pasted content and converts them to appropriate HTML elements
 *
 * Features:
 * - Image URL detection and conversion to <img> tags
 * - YouTube URL detection and conversion to embeds
 * - Regular URL conversion to <a> tags with security checks
 * - XSS prevention (protocol validation, URL escaping)
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - HTML-escaped text
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Detect if pasted text is a URL and convert to appropriate HTML
 * Handles images, YouTube videos, and regular links
 *
 * @param {string} text - The pasted text
 * @returns {Object} - { isUrl, isYouTube, isImage, html, url, videoId }
 */
export function detectAndConvertUrls(text) {
  // Trim and normalize whitespace (remove all newlines/returns)
  const trimmed = text.trim().replace(/[\n\r]/g, '');
  if (!trimmed) {
    return { isUrl: false };
  }

  // Check if it's a valid URL
  const urlPattern = /^https?:\/\/.+/i;
  if (!urlPattern.test(trimmed)) {
    return { isUrl: false };
  }

  // Security: Limit URL length to prevent DoS attacks
  const MAX_URL_LENGTH = 2048; // Standard browser limit
  if (trimmed.length > MAX_URL_LENGTH) {
    console.warn(`URL too long (${trimmed.length} chars), max is ${MAX_URL_LENGTH}`);
    return { isUrl: false };
  }

  // Validate it's actually a URL
  let url;
  try {
    url = new URL(trimmed);
  } catch (e) {
    return { isUrl: false };
  }

  // Security: Only allow http/https protocols (block javascript:, data:, file:, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`Blocked unsafe URL protocol: ${url.protocol}`);
    return { isUrl: false };
  }

  // Check for image URLs
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;
  if (imageExtensions.test(url.pathname)) {
    // Escape URL for safe insertion (prevent attribute breakout)
    const safeUrl = escapeHtml(url.href);
    const imageHtml = `<img src="${safeUrl}" class="external-link" alt="Pasted image" referrerpolicy="no-referrer" />`;

    return {
      isUrl: true,
      isImage: true,
      html: imageHtml,
      url: url.href
    };
  }

  // Check for YouTube URLs
  const youtubePatterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|m\.youtube\.com\/watch\?v=|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of youtubePatterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];

      // Generate YouTube embed HTML (IDs will be added by setElementIds later)
      // Note: Outer div is selectable (for deletion), inner wrapper is not editable
      const embedHtml = `<div class="video-embed">
  <button class="video-delete-btn" contenteditable="false" aria-label="Delete video" data-action="delete-video">×</button>
  <div class="video-wrapper" contenteditable="false">
    <iframe src="https://www.youtube.com/embed/${videoId}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen>
    </iframe>
  </div>
</div>`;

      return {
        isUrl: true,
        isYouTube: true,
        html: embedHtml,
        url: trimmed,
        videoId
      };
    }
  }

  // Regular URL - create link with HTML-escaped display text
  const escapedDisplayUrl = escapeHtml(url.href);
  const escapedHrefUrl = escapeHtml(url.href);
  const linkHtml = `<a href="${escapedHrefUrl}" class="external-link" target="_blank" rel="noopener noreferrer">${escapedDisplayUrl}</a>`;

  return {
    isUrl: true,
    isYouTube: false,
    html: linkHtml,
    url: url.href
  };
}
