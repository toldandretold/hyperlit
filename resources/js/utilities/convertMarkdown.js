// import { processFootnotes} from './footnotes.js';
// import { saveFootnotesToIndexedDB } from '../indexedDB/index.js';
import { book } from '../app.js';

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
export function parseMarkdownIntoChunksInitial(markdown) {
  // Process footnotes first to have them ready
  const footnoteData = processFootnotes(markdown);
  console.log("Footnote Data:", footnoteData);
  footnoteData.pairs.forEach(pair => {
    if (!pair.definition.content) {
      console.warn(
        `Missing content for footnote with id "${pair.reference.id}" at definition line ${pair.definition.lineNumber}`
      );
    }
  });
  
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
    const nodeNumber = index + 1; // Use sequential numbering as the line number for this node.

    // Assign the id and data-block-id to the element.
    el.id = nodeNumber;
    el.setAttribute("data-block-id", nodeNumber);
    
    // Ensure nested elements don't have IDs that could confuse our highlight system.
    const nestedElements = el.querySelectorAll("*");
    nestedElements.forEach(nested => {
      // If it's not a block-level element we care about, remove any ID.
      if (
        !["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TABLE"].includes(
          nested.tagName
        )
      ) {
        nested.removeAttribute("id");
      }
    });

    // Create a block object for this node.
    const node = {
      chunk_id: chunkId,
      type: el.tagName.toLowerCase(), // e.g., "p", "h1", etc.
      content: el.outerHTML, // Pre-rendered HTML (with id and data attributes).
      plainText: el.textContent, // The text content for accurate highlight calculations.
      startLine: nodeNumber, // The node's sequential number.
      hyperlights: [],
      hypercites: [],
      footnotes: [] // Here we'll store our paired footnotes.
    };
    
    // Add footnotes that belong to this node.
    const nodeFootnotes = footnoteData.pairs.filter(pair => {
      // This assumes each node corresponds to one line, so we match on nodeNumber
      return pair.reference.lineNumber === nodeNumber;
    });
    
    if (nodeFootnotes.length > 0) {
      node.footnotes = nodeFootnotes.map(pair => ({
        id: pair.reference.id,
        content: pair.definition.content || "",
        referenceLine: pair.reference.lineNumber,
        definitionLine: pair.definition.lineNumber
      }));
    }

    nodes.push(node);

    if ((index + 1) % chunkSize === 0) {
      chunkId++;
    }
  });

  // Prepare the footnotes data to be saved
  // (for saving to IndexedDB elsewhere)
  const footnotesToSave = footnoteData.pairs.map(pair => ({
    id: pair.reference.id,
    content: pair.definition.content
  }));

  // Save the footnotes to IndexedDB
  saveFootnotesToIndexedDB(footnotesToSave, book);

  return nodes;
}



/**
 * Enhanced version of convertMarkdownToHtml that handles footnote references
 */
export function convertMarkdownToHtml(markdown) {
  const lines = markdown.split("\n");
  let htmlOutput = "";

  lines.forEach((line, index) => {
    const originalLineNumber = index + 1;
    const lineNumberAttr = `data-original-line="${originalLineNumber}"`;
    const trimmedLine = line.trim();

    // Process footnote definition lines differently.
    if (trimmedLine.match(/^\[\^(\w+)\]\:(.*)/)) {
      // Wrap footnote definitions in a span with a class so they can be hidden.
      htmlOutput += `<span class="footnote-definition" ${lineNumberAttr} style="display:none;">${line}</span>`;
      return;
    }
    
    // Process other lines based on type
    if (trimmedLine.startsWith("# ")) {
      htmlOutput += `<h1 ${lineNumberAttr}>${parseInlineMarkdown(
        trimmedLine.replace(/^# /, "")
      )}</h1>`;
    } else if (trimmedLine.startsWith("## ")) {
      htmlOutput += `<h2 ${lineNumberAttr}>${parseInlineMarkdown(
        trimmedLine.replace(/^## /, "")
      )}</h2>`;
    } else if (trimmedLine.startsWith("### ")) {
      htmlOutput += `<h3 ${lineNumberAttr}>${parseInlineMarkdown(
        trimmedLine.replace(/^### /, "")
      )}</h3>`;
    } else if (trimmedLine.startsWith(">")) {
      htmlOutput += `<blockquote ${lineNumberAttr}>${parseInlineMarkdown(
        trimmedLine.replace(/^> /, "")
      )}</blockquote>`;
    } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
      const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
      if (imageMatch) {
        const altText = imageMatch[1];
        const imageUrl = imageMatch[2];
        htmlOutput += `<img ${lineNumberAttr} src="${imageUrl}" alt="${altText}"/>`;
      }
    } else if (trimmedLine) {
      htmlOutput += `<p ${lineNumberAttr}>${parseInlineMarkdown(trimmedLine)}</p>`;
    } else {
      // For empty lines, you might still output a placeholder element.
      htmlOutput += `<div ${lineNumberAttr}></div>`;
    }
  });

  return htmlOutput;
}


/**
 * Enhanced version of parseInlineMarkdown that handles footnote references
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
