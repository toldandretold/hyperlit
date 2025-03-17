/**
 * Converts the raw markdown into pre-rendered HTML,
 * then creates an array of objects, where each object represents a single HTML
 * node with a `chunk_id`.
 *
 * Each object will have:
 *   - chunk_id: a unique grouping identifier (e.g., 0, 1, 2, ...)
 *   - type: the node's tag (e.g., "p", "h1", etc.)
 *   - content: the pre-rendered HTML string (with the proper id and
 *     data-block-id inserted)
 *   - plainText: the element's textContent (for accurate highlight
 *     calculations)
 *   - startLine: the sequential number of that node
 *   - hyperlights, hypercites, footnotes: empty arrays to be filled when
 *     annotations are added.
 *
 * @param {string} markdown The markdown source.
 * @returns {Array<Object>} An array of objects, each representing an HTML
 * node with a `chunk_id` for IndexedDB.
 */
export function parseMarkdownIntoChunks(markdown) {
  // Convert the markdown to HTML using your conversion function.
  const html = convertMarkdownToHtml(markdown);

  // Create a temporary container element and set its innerHTML.
  const container = document.createElement("div");
  container.innerHTML = html;

  // Retrieve only the top-level element nodes.
  const elements = Array.from(container.children);

  const nodes = [];
  let chunkId = 0;
  const chunkSize = 100;

  elements.forEach((el, index) => {
    const nodeNumber = index + 1; // Use sequential numbering as the line
    // number for this node.

    // Assign the id and data-block-id to the element.
    el.id = nodeNumber;
    el.setAttribute("data-block-id", nodeNumber);

    // Create a block object for this node.
    const node = {
      chunk_id: chunkId,
      type: el.tagName.toLowerCase(), // For example "p", "h1", etc.
      content: el.outerHTML, // Pre-rendered HTML (with id and data
      // attributes).
      plainText: el.textContent, // The text content for accurate highlight
      // calculations.
      startLine: nodeNumber, // The node's sequential number.
      hyperlights: [],
      hypercites: [],
      footnotes: []
    };

    nodes.push(node);

    if ((index + 1) % chunkSize === 0) {
      chunkId++;
    }
  });

  return nodes;
}

/**
 * (Optional) A helper that converts inline markdown syntax to HTML.
 */
export function parseInlineMarkdown(text) {
  if (!text) return "";
  // Remove escape characters.
  text = text.replace(/\\([`*_{}\\[\\]()#+.!-])/g, "$1");
  // Bold: **text** -> <strong>text</strong>
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italics: *text* -> <em>text</em>
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Inline code: `code` -> <code>code</code>
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return text;
}

/**
 * Converts markdown to HTML.
 * You can use your existing logic or an external library.
 */
export function convertMarkdownToHtml(markdown) {
  const lines = markdown.split("\n");
  let htmlOutput = "";

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("# ")) {
      htmlOutput += `<h1>${parseInlineMarkdown(
        trimmedLine.replace(/^# /, "")
      )}</h1>`;
    } else if (trimmedLine.startsWith("## ")) {
      htmlOutput += `<h2>${parseInlineMarkdown(
        trimmedLine.replace(/^## /, "")
      )}</h2>`;
    } else if (trimmedLine.startsWith("### ")) {
      htmlOutput += `<h3>${parseInlineMarkdown(
        trimmedLine.replace(/^### /, "")
      )}</h3>`;
    } else if (trimmedLine.startsWith(">")) {
      htmlOutput += `<blockquote>${parseInlineMarkdown(
        trimmedLine.replace(/^> /, "")
      )}</blockquote>`;
    } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
      const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
      if (imageMatch) {
        const altText = imageMatch[1];
        const imageUrl = imageMatch[2];
        htmlOutput += `<img src="${imageUrl}" alt="${altText}"/>`;
      }
    } else if (trimmedLine) {
      htmlOutput += `<p>${parseInlineMarkdown(trimmedLine)}</p>`;
    }
  });

  return htmlOutput;
}

/**
 * (Optional) A simple render function to return a block's pre-rendered HTML.
 * Since each block already contains the final HTML, this may simply return it.
 */
export function renderBlockToHtml(block) {
  if (!block || !block.content) {
    console.error("❌ Invalid block detected:", block);
    return "";
  }
  return block.content;
}
