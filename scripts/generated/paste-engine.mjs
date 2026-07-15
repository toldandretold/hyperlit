// resources/js/paste/utils/normalizer.ts
function normalizeQuotes(text) {
  if (!text) return text;
  return text.replace(/‘/g, "'").replace(/’/g, "'").replace(/“/g, '"').replace(/”/g, '"').replace(/`/g, "'");
}
function normalizeSpaces(html) {
  if (!html) return html;
  return html.replace(/<span class="Apple-converted-space">\s*&nbsp;\s*<\/span>/g, " ").replace(/<span class="Apple-converted-space">\s*<\/span>/g, " ").replace(/&amp;\s*nbsp;/gi, " ").replace(/&nbsp;/g, " ");
}
function normalizeContent(text, isHtml = false) {
  if (!text) return text;
  let normalized = normalizeQuotes(text);
  if (isHtml) {
    normalized = normalizeSpaces(normalized);
  }
  return normalized;
}

// resources/js/utilities/blockElements.ts
var BLOCK_ELEMENT_TAGS = /* @__PURE__ */ new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "DIV",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "TABLE",
  "HR",
  "FIGURE"
]);
var BLOCK_ELEMENT_SELECTOR = Array.from(BLOCK_ELEMENT_TAGS).map((t) => t.toLowerCase()).join(", ");
var STRUCTURAL_BLOCK_TAGS = /* @__PURE__ */ new Set([
  ...BLOCK_ELEMENT_TAGS,
  "LI",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "NAV",
  "MAIN",
  "FIGCAPTION",
  "TR",
  "TD",
  "TH"
]);
function isStructuralBlockTag(tagName) {
  return STRUCTURAL_BLOCK_TAGS.has(tagName.toUpperCase());
}

// resources/js/paste/utils/dom-utils.ts
function isBlockElement(tagName) {
  return isStructuralBlockTag(tagName);
}
function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  el.remove();
}
var NON_CONTENT_BLOCK_TAGS = ["div", "article", "section", "main", "header", "footer", "aside", "nav", "button"];
function unwrapNonContentContainers(container, doc = document) {
  const selector = NON_CONTENT_BLOCK_TAGS.join(", ");
  const containers = Array.from(container.querySelectorAll(selector)).reverse();
  containers.forEach((el) => {
    wrapLooseNodes(el, doc);
    unwrap(el);
  });
}
function wrapLooseNodes(container, doc = document) {
  const nodesToProcess = Array.from(container.childNodes);
  let currentWrapper = null;
  for (const node of nodesToProcess) {
    const isBlock = node.nodeType === Node.ELEMENT_NODE && STRUCTURAL_BLOCK_TAGS.has(node.tagName);
    if (isBlock) {
      currentWrapper = null;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === "") {
      continue;
    }
    if (!currentWrapper) {
      currentWrapper = doc.createElement("p");
      container.insertBefore(currentWrapper, node);
    }
    currentWrapper.appendChild(node);
  }
}
function createTempDOM(html) {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;
  return tempDiv;
}
function removeEmptyBlocks(container) {
  container.querySelectorAll("p, blockquote, h1, h2, h3").forEach((el) => {
    if (!el.textContent.trim() && !el.querySelector("img") && !el.querySelector("a[id^='pasted-']")) {
      el.remove();
    }
  });
}
function stripAttributes(container, idPrefix = "") {
  container.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("style");
    el.removeAttribute("class");
    if (el.id && !el.id.startsWith(idPrefix)) {
      el.removeAttribute("id");
    }
    el.removeAttribute("data-node-id");
  });
}
function groupInlineElements(container, doc = document) {
  const looseInlineElements = Array.from(container.childNodes).filter(
    (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName && !isBlockElement(node.tagName)
  );
  if (looseInlineElements.length === 0) return;
  let currentWrapper = null;
  const nodesToProcess = Array.from(container.childNodes);
  nodesToProcess.forEach((node) => {
    if (!container.contains(node)) return;
    const isLooseInline = node.nodeType === Node.ELEMENT_NODE && node.tagName && !isBlockElement(node.tagName);
    const isTextWithContent = node.nodeType === Node.TEXT_NODE && node.textContent.trim();
    if (isLooseInline || isTextWithContent) {
      if (!currentWrapper || !container.contains(currentWrapper)) {
        currentWrapper = doc.createElement("p");
        container.insertBefore(currentWrapper, node);
      }
      currentWrapper.appendChild(node);
    } else if (node.nodeType === Node.ELEMENT_NODE && isBlockElement(node.tagName)) {
      currentWrapper = null;
    }
  });
}
function visuallyStartsWith(htmlContent, textPattern) {
  const temp = document.createElement("div");
  temp.innerHTML = htmlContent.trim();
  const visibleText = temp.textContent.trim();
  return visibleText.startsWith(textPattern);
}
function isReferenceSectionHeading(headingText) {
  const normalized = headingText.trim().toLowerCase().replace(/\s+/g, " ");
  const exactPatterns = [
    "footnote",
    "footnotes",
    "endnote",
    "endnotes",
    "end note",
    "end notes",
    "note",
    "notes",
    "bibliography",
    "bibliographies",
    "reference",
    "references",
    "reference list",
    "works cited",
    "works consulted",
    "sources",
    "literature cited"
  ];
  if (exactPatterns.includes(normalized)) {
    return true;
  }
  const startsWithPatterns = ["notes:", "references:", "bibliography:"];
  for (const pattern of startsWithPatterns) {
    if (normalized.startsWith(pattern)) return true;
  }
  return false;
}

// resources/js/paste/utils/reference-key-generator.ts
function generateReferenceKeys(text, contextText = "", formatType = "general") {
  const processedText = text.replace(/\[(\d{4})\]/g, " $1 ");
  const yearMatch = processedText.match(/(\d{4}[a-z]?)/);
  if (!yearMatch) return [];
  const year = yearMatch[1];
  const authorsText = text.split(year)[0];
  const keys = [];
  const addKey = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  const hasAuthor = /[a-zA-Z]/.test(authorsText);
  let authorSource = hasAuthor ? authorsText : contextText;
  if (formatType === "taylor-francis") {
    const tfCitationMatch = text.match(/CIT(\d+)/);
    if (tfCitationMatch && year) {
      const citationId = tfCitationMatch[1];
      addKey("cit" + citationId + year);
      addKey("citation" + citationId + year);
    }
    if (hasAuthor) {
      const tfAuthorMatch = authorsText.match(/([A-Z][a-zA-Z']+)/);
      if (tfAuthorMatch) {
        const surname = tfAuthorMatch[1];
        addKey(surname.toLowerCase() + year);
      }
    }
  }
  if (formatType === "oup" && hasAuthor) {
    const oupMatch = authorsText.match(/^([A-Z][a-zA-Z'-]+)\s+([A-Z][a-zA-Z']+)/);
    if (oupMatch) {
      const [, surname, firstname] = oupMatch;
      addKey(surname.toLowerCase() + year);
      addKey(surname.toLowerCase() + firstname.toLowerCase() + year);
      if (surname.includes("-")) {
        addKey(surname.toLowerCase().replace(/-/g, "") + year);
      }
      return keys;
    }
  }
  if (authorSource) {
    let sourceText = authorSource;
    if (!hasAuthor && contextText) {
      const words = contextText.trim().split(/\s+/);
      const nameParts = [];
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i].replace(/,$/, "");
        if (/^[A-Z]/.test(word) || /^(van|der|de|la|von)$/i.test(word)) {
          nameParts.unshift(word);
        } else {
          break;
        }
        if (nameParts.length >= 4) break;
      }
      if (nameParts.length > 0) {
        sourceText = nameParts.join(" ");
      } else {
        const candidates = sourceText.match(/\b[A-Z][a-zA-Z'-]+\b/g);
        if (candidates) sourceText = candidates[candidates.length - 1];
      }
    }
    const acronyms = sourceText.match(/\b[A-Z]{2,}\b/g) || [];
    acronyms.forEach((acronym) => {
      addKey(acronym.toLowerCase() + year);
    });
    const surnames = (sourceText.match(/\b[A-Z][a-zA-Z'-]+\b/g) || []).filter((s) => !["And", "The", "For", "In", "An", "On", "As", "Ed", "Of", "See", "Also"].includes(s)).filter((s) => !acronyms.includes(s)).map((s) => s.toLowerCase().replace("'s", ""));
    if (surnames.length > 0) {
      const sortedSurnames = [...surnames].sort();
      addKey(sortedSurnames.join("") + year);
      if (surnames.length > 1 && !sourceText.includes(",")) {
        addKey(surnames.join("") + year);
      }
      if (sourceText.includes(",")) {
        addKey(surnames[0] + year);
      } else if (surnames.length > 0) {
        addKey(surnames[surnames.length - 1] + year);
      }
      surnames.forEach((surname) => {
        if (surname.includes("-")) {
          addKey(surname.replace(/-/g, "") + year);
        }
      });
    }
    const initials = sourceText.match(/\b[A-Z]/g)?.join("");
    if (initials && initials.length >= 2) {
      addKey(initials.toLowerCase() + year);
    }
  }
  if (text.includes("United Nations General Assembly")) {
    addKey("un" + year);
  }
  return keys;
}

// resources/js/paste/utils/citation-linker.ts
function processInTextCitations(htmlContent, referenceMappings, allReferences = [], formatType = "general") {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = htmlContent;
  if (formatType === "taylor-francis") {
    console.log(`\u{1F4DA} T&F: Processing in-text citations with ${referenceMappings.size} reference mappings`);
  }
  let anchorLinksConverted = 0;
  const allAnchors = tempDiv.querySelectorAll("a[href]");
  allAnchors.forEach((link) => {
    if (link.closest('[data-static-content="bibliography"]')) return;
    if (link.classList.contains("in-text-citation")) return;
    const href = link.getAttribute("href");
    if (!href) return;
    const fragmentMatch = href.match(/#([a-zA-Z][\w-]*)$/);
    if (!fragmentMatch) return;
    const anchorId = fragmentMatch[1];
    if (referenceMappings.has(anchorId)) {
      link.setAttribute("href", "#" + referenceMappings.get(anchorId));
      link.classList.add("in-text-citation");
      anchorLinksConverted++;
    }
  });
  if (anchorLinksConverted > 0) {
    console.log(`  - \u2705 Converted ${anchorLinksConverted} anchor-based citations to Hyperlit format`);
  }
  const walker = document.createTreeWalker(
    tempDiv,
    NodeFilter.SHOW_TEXT,
    null
  );
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && !["SCRIPT", "STYLE", "A"].includes(parent.tagName)) {
      const isStaticBibliography = parent.getAttribute("data-static-content") === "bibliography" || parent.closest('[data-static-content="bibliography"]');
      if (isStaticBibliography) {
        continue;
      }
      textNodes.push(node);
    }
  }
  textNodes.forEach((textNode) => {
    const text = textNode.textContent;
    const citationPattern = /\(([^)]*?\d{4}[^)]*?)\)/g;
    let match;
    const replacements = [];
    while ((match = citationPattern.exec(text)) !== null) {
      const citationBlock = match[1];
      const subCitations = citationBlock.split(/;\s*/);
      let linkedParts = [];
      subCitations.forEach((subCite, index) => {
        const trimmed = subCite.trim();
        if (!trimmed) return;
        let processedCite = trimmed;
        const prefixes = ["Cited in ", "Quoted in ", "see ", "e.g., ", "cf. "];
        for (const prefix of prefixes) {
          if (processedCite.toLowerCase().startsWith(prefix.toLowerCase())) {
            processedCite = processedCite.substring(prefix.length);
            break;
          }
        }
        const keys = generateReferenceKeys(processedCite, text.substring(0, match.index), formatType);
        let linked = false;
        let referenceId = null;
        for (const key of keys) {
          if (referenceMappings.has(key)) {
            referenceId = referenceMappings.get(key);
            linked = true;
            break;
          }
        }
        if (!linked) {
          const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
          const authorMatch = processedCite.match(/^([A-Z]{2,})/);
          if (yearMatch && authorMatch && allReferences.length > 0) {
            const year = yearMatch[1];
            const acronym = authorMatch[1];
            for (const reference of allReferences) {
              if (reference.originalText.includes(year)) {
                const authorPart = reference.originalText.split(year)[0];
                const initials = authorPart.match(/\b[A-Z]/g)?.join("");
                if (initials === acronym) {
                  referenceId = reference.referenceId;
                  linked = true;
                  break;
                }
              }
            }
          }
        }
        if (linked) {
          const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
          if (yearMatch) {
            const authorPart = processedCite.substring(0, yearMatch.index);
            const yearPart = yearMatch[1];
            const trailingPart = processedCite.substring(yearMatch.index + yearMatch[0].length);
            const originalPrefix = trimmed.substring(0, trimmed.length - processedCite.length);
            linkedParts.push(
              originalPrefix + authorPart,
              `<a href="#${referenceId}" class="in-text-citation">${yearPart}</a>`,
              trailingPart
            );
          } else {
            linkedParts.push(`<a href="#${referenceId}" class="in-text-citation">${trimmed}</a>`);
          }
        } else {
          linkedParts.push(trimmed);
        }
        if (index < subCitations.length - 1) linkedParts.push("; ");
      });
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: `(${linkedParts.join("")})`
      });
    }
    if (replacements.length > 0) {
      let newHTML = text;
      for (let i = replacements.length - 1; i >= 0; i--) {
        const repl = replacements[i];
        newHTML = newHTML.substring(0, repl.start) + repl.replacement + newHTML.substring(repl.end);
      }
      const span = document.createElement("span");
      span.innerHTML = newHTML;
      textNode.parentNode.replaceChild(span, textNode);
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  });
  return tempDiv.innerHTML;
}

// resources/js/paste/utils/footnote-linker.ts
function createFootnoteSupElement(footnoteId, displayNumber) {
  const sup = document.createElement("sup");
  sup.id = footnoteId;
  sup.setAttribute("fn-count-id", displayNumber);
  sup.className = "footnote-ref";
  sup.textContent = displayNumber;
  return sup;
}
function processFootnoteReferences(htmlContent, footnoteMappings, formatType = "general") {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = htmlContent;
  const supElements = tempDiv.querySelectorAll("sup");
  supElements.forEach((sup) => {
    if (sup.closest("[data-static-content]")) {
      return;
    }
    const link = sup.querySelector("a[href]");
    if (link) {
      const href = link.getAttribute("href");
      const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
      if (fragmentMatch) {
        const identifier2 = fragmentMatch[1];
        if (footnoteMappings.has(identifier2)) {
          const mapping = footnoteMappings.get(identifier2);
          sup.id = mapping.uniqueId;
          sup.setAttribute("fn-count-id", identifier2);
          sup.className = "footnote-ref";
          sup.textContent = identifier2;
          return;
        }
      }
    }
    const identifier = sup.textContent.trim();
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);
      sup.id = mapping.uniqueId;
      sup.setAttribute("fn-count-id", identifier);
      sup.className = "footnote-ref";
      const existingLink = sup.querySelector("a");
      if (existingLink) {
        sup.textContent = identifier;
      }
    }
  });
  const allAnchors = tempDiv.querySelectorAll("a[href]");
  let bareLinksConverted = 0;
  allAnchors.forEach((link) => {
    if (link.closest("[data-static-content]")) return;
    if (link.closest("sup")) return;
    const href = link.getAttribute("href");
    const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
    if (!fragmentMatch) return;
    const identifier = fragmentMatch[1];
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);
      const sup = document.createElement("sup");
      sup.id = mapping.uniqueId;
      sup.setAttribute("fn-count-id", identifier);
      sup.className = "footnote-ref";
      sup.textContent = identifier;
      link.parentNode.replaceChild(sup, link);
      bareLinksConverted++;
    }
  });
  if (bareLinksConverted > 0) {
    console.log(`  - Converted ${bareLinksConverted} bare anchor footnote links to <sup> format`);
  }
  const walker = document.createTreeWalker(
    tempDiv,
    NodeFilter.SHOW_TEXT,
    null
  );
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    if (node.parentElement && !["SCRIPT", "STYLE", "A", "SUP"].includes(node.parentElement.tagName)) {
      if (node.parentElement.closest("[data-static-content]")) {
        continue;
      }
      textNodes.push(node);
    }
  }
  textNodes.forEach((textNode) => {
    const text = textNode.textContent;
    const replacements = [];
    const footnoteRefPattern = /\[\^?(\d+)\]/g;
    let match;
    while ((match = footnoteRefPattern.exec(text)) !== null) {
      const identifier = match[1];
      const nextChar = text[match.index + match[0].length];
      if (nextChar === ":") continue;
      if (footnoteMappings.has(identifier)) {
        const mapping = footnoteMappings.get(identifier);
        const supHTML = `<sup fn-count-id="${identifier}" id="${mapping.uniqueId}" class="footnote-ref">${identifier}</sup>`;
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: supHTML
        });
      }
    }
    const skipPlainTextPattern = ["cambridge", "oup", "taylor-francis", "sage"].includes(formatType);
    if (!skipPlainTextPattern) {
      const plainFootnotePattern = /([.!?])\s*(\d{1,2})(?=\s+[A-Z]|\s*$)/g;
      while ((match = plainFootnotePattern.exec(text)) !== null) {
        const identifier = match[2];
        const punctuation = match[1];
        const numericId = parseInt(identifier, 10);
        const contextBefore = text.substring(Math.max(0, match.index - 10), match.index);
        const looksLikeYear = /\b(in|since|by|from|until|after|before)\s*$/.test(contextBefore);
        const looksLikeSectionNumber = /\d$/.test(contextBefore);
        if (footnoteMappings.has(identifier) && numericId <= 99 && !looksLikeYear && !looksLikeSectionNumber) {
          const mapping = footnoteMappings.get(identifier);
          const supHTML = `${punctuation}<sup fn-count-id="${identifier}" id="${mapping.uniqueId}" class="footnote-ref">${identifier}</sup>`;
          replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            replacement: supHTML
          });
        }
      }
    } else {
      console.log(`\u{1F4DD} Skipping plain text footnote pattern for ${formatType} format (footnotes already marked)`);
    }
    if (replacements.length > 0) {
      replacements.sort((a, b) => b.start - a.start);
      let newHTML = text;
      replacements.forEach((repl) => {
        newHTML = newHTML.substring(0, repl.start) + repl.replacement + newHTML.substring(repl.end);
      });
      const span = document.createElement("span");
      span.innerHTML = newHTML;
      textNode.parentNode.replaceChild(span, textNode);
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  });
  return tempDiv.innerHTML;
}

// resources/js/utilities/sanitizeConfig.ts
import DOMPurify from "dompurify";
var ADD_ATTR = [
  "content-id",
  // OUP footnote/citation linking
  "reveal-id",
  // OUP citation modals
  "role",
  // SAGE listitem references
  "aria-controls",
  // OUP author flyouts
  "aria-expanded",
  // OUP author flyouts
  "fn-count-id",
  // Footnote click handler identifier
  "no-delete-id"
  // Protects last node from deletion (empty document prevention)
];
var ADD_TAGS = ["latex", "latex-block"];
var FORBID_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "style",
  "link",
  "meta",
  "base",
  // SVG allowed for icons, but block dangerous SVG-specific elements
  "foreignObject",
  // Can embed arbitrary HTML inside SVG
  "set",
  // SVG animation that can trigger scripts
  "animate",
  // SVG animation element
  "animateMotion",
  "animateTransform",
  // More SVG animation elements
  "template",
  "slot",
  "noscript",
  "canvas",
  "dl",
  "dt",
  "dd"
  // Definition list tags - not supported in editor
];
var FORBID_ATTR = [
  // Event handlers
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onmouseout",
  "onmouseenter",
  "onmouseleave",
  "onmousedown",
  "onmouseup",
  "onfocus",
  "onblur",
  "onchange",
  "oninput",
  "onsubmit",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "ondrag",
  "ondrop",
  "ondragover",
  "ondragstart",
  "ondragend",
  "onscroll",
  "onresize",
  "onwheel",
  "onanimationstart",
  "onanimationend",
  "onanimationiteration",
  "ontransitionend",
  "onplay",
  "onpause",
  "onended",
  "onloadstart",
  "onprogress",
  "oncanplay",
  "oncanplaythrough",
  "ontimeupdate",
  "onseeking",
  "onseeked",
  "onvolumechange",
  "oncontextmenu",
  "oncopy",
  "oncut",
  "onpaste",
  "onbeforeunload",
  "onunload",
  "onhashchange",
  "onpopstate",
  "onstorage",
  "onmessage",
  "onoffline",
  "ononline",
  "onshow",
  "ontoggle",
  "oninvalid",
  "onreset",
  "onsearch",
  "onselect",
  "onabort",
  "onauxclick",
  "onbeforecopy",
  "onbeforecut",
  "onbeforepaste"
  // Note: 'style' is allowed but sanitized via hook below to remove XSS vectors
];
function sanitizeHtml(html) {
  if (!html) return "";
  const result = DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS,
    // Allow custom latex/latex-block elements
    ADD_ATTR,
    // Allow publisher-specific non-data attributes
    ALLOW_DATA_ATTR: true,
    // Let data-* attributes through for journal formats
    KEEP_CONTENT: true
    // Keep text content of removed tags
  });
  return result;
}
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "href" || data.attrName === "src") {
    const value = data.attrValue.toLowerCase().trim();
    if (value.startsWith("javascript:") || value.startsWith("vbscript:") || value.startsWith("data:text/html") || value.startsWith("data:application")) {
      data.attrValue = "";
      data.keepAttr = false;
    }
  }
  if (data.attrName === "style") {
    const value = data.attrValue.toLowerCase();
    const dangerousPatterns = [
      "url(",
      // Can load external resources
      "expression(",
      // IE CSS expressions
      "behavior:",
      // IE behaviors
      "javascript:",
      // JS in CSS
      "vbscript:",
      // VBScript
      "-moz-binding",
      // Firefox XBL
      "@import",
      // External CSS
      "@charset"
      // Encoding tricks
    ];
    if (dangerousPatterns.some((pattern) => value.includes(pattern))) {
      data.attrValue = "";
      data.keepAttr = false;
    }
  }
});

// resources/js/paste/format-processors/base-processor.ts
var BaseFormatProcessor = class {
  /**
   * @param {string} formatType - Format identifier (e.g., 'cambridge', 'oup')
   */
  constructor(formatType) {
    this.formatType = formatType;
  }
  /**
   * Template method - defines the algorithm structure
   * Subclasses override specific stages but cannot change the order
   *
   * @param {string} htmlContent - Raw HTML content to process
   * @param {string} bookId - Book identifier for database operations
   * @returns {Promise<{html: string, footnotes: Array, references: Array, formatType: string}>}
   */
  async process(htmlContent, bookId) {
    console.log(`\u{1F4DA} Processing ${this.formatType} format`);
    const dom = this.createDOM(htmlContent);
    this.normalize(dom);
    const footnotes = await this.extractFootnotes(dom, bookId);
    console.log(`  - Extracted ${footnotes.length} footnotes`);
    footnotes.forEach((footnote) => {
      if (footnote.content) {
        const temp = document.createElement("div");
        temp.innerHTML = footnote.content;
        stripAttributes(temp, "pasted-");
        footnote.content = temp.innerHTML;
      }
    });
    const references = await this.extractReferences(dom, bookId);
    console.log(`  - Extracted ${references.length} references`);
    references.forEach((reference) => {
      if (reference.content) {
        const temp = document.createElement("div");
        temp.innerHTML = reference.content;
        stripAttributes(temp, "pasted-");
        reference.content = temp.innerHTML;
      }
    });
    await this.transformStructure(dom, bookId);
    this.cleanup(dom);
    this.appendStaticSections(dom, footnotes, references);
    this.linkCitations(dom, references);
    this.linkFootnotes(dom, footnotes);
    console.log(`\u2705 ${this.formatType} processing complete`);
    return {
      html: dom.innerHTML,
      footnotes,
      references,
      formatType: this.formatType
    };
  }
  /**
   * Lightweight processing for small pastes (≤10 nodes)
   * Only runs security-critical stages: normalize + cleanup
   * Skips footnote/reference extraction, structure transformation, and linking
   *
   * @param {string} htmlContent - Raw HTML content to process
   * @param {string} bookId - Book identifier for database operations
   * @returns {Promise<{html: string, footnotes: Array, references: Array, formatType: string}>}
   */
  async processLite(htmlContent, bookId) {
    console.log(`\u{1F4DA} [LITE] Processing ${this.formatType} format (minimal)`);
    const dom = this.createDOM(htmlContent);
    this.normalize(dom);
    this.cleanup(dom);
    console.log(`\u2705 [LITE] ${this.formatType} processing complete`);
    return {
      html: dom.innerHTML,
      footnotes: [],
      references: [],
      formatType: this.formatType
    };
  }
  // ========================================================================
  // COMMON STAGES (implemented in base class)
  // ========================================================================
  /**
   * Create a temporary DOM element from HTML
   * @param {string} html - HTML content
   * @returns {HTMLElement} - DOM element
   */
  createDOM(html) {
    const sanitizedHtml = sanitizeHtml(html);
    return createTempDOM(sanitizedHtml);
  }
  /**
   * Normalize content (smart quotes, nbsp, etc.)
   * @param {HTMLElement} dom - DOM to normalize
   */
  normalize(dom) {
    const normalizedHtml = normalizeContent(dom.innerHTML, true);
    dom.innerHTML = normalizedHtml;
  }
  /**
   * Link in-text citations to references
   * Common pattern: (Author, Year) → linked to reference
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Extracted references with mappings
   */
  linkCitations(dom, references) {
    if (!references || references.length === 0) return;
    const referenceMappings = /* @__PURE__ */ new Map();
    references.forEach((ref, index) => {
      if (ref.needsKeyGeneration) {
        const refKeys = generateReferenceKeys(ref.originalText || ref.content, "", this.formatType);
        if (!ref.referenceId) {
          if (refKeys.length > 0) {
            ref.referenceId = refKeys[0];
          } else {
            ref.referenceId = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            console.warn(`\u26A0\uFE0F ${this.formatType}: No keys generated for reference, using fallback ID: ${ref.referenceId}`);
          }
        }
        ref.refKeys = refKeys.length > 0 ? refKeys : [ref.referenceId];
        ref.refKeys.forEach((key) => {
          referenceMappings.set(key, ref.referenceId);
        });
      } else if (ref.refKeys && ref.referenceId) {
        ref.refKeys.forEach((key) => {
          referenceMappings.set(key, ref.referenceId);
        });
      }
      if (ref.originalAnchorId && ref.referenceId) {
        referenceMappings.set(ref.originalAnchorId, ref.referenceId);
      }
      if (ref.xmlRid && ref.referenceId) {
        referenceMappings.set(ref.xmlRid, ref.referenceId);
      }
    });
    console.log(`  - Built reference mappings: ${referenceMappings.size} keys for ${references.length} references`);
    if (referenceMappings.size > 0) {
      const linkedHtml = processInTextCitations(dom.innerHTML, referenceMappings, references, this.formatType);
      dom.innerHTML = linkedHtml;
      console.log(`  - Citation linking complete`);
    }
  }
  /**
   * Link footnote references to footnotes
   * Common pattern: <sup>1</sup> → linked to footnote
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Extracted footnotes with mappings
   */
  linkFootnotes(dom, footnotes) {
    if (!footnotes || footnotes.length === 0) return;
    const footnoteMappings = /* @__PURE__ */ new Map();
    footnotes.forEach((footnote) => {
      if (footnote.originalIdentifier) {
        footnoteMappings.set(footnote.originalIdentifier, {
          uniqueId: footnote.footnoteId,
          uniqueRefId: footnote.refId
        });
      }
    });
    if (footnoteMappings.size > 0) {
      const linkedHtml = processFootnoteReferences(dom.innerHTML, footnoteMappings, this.formatType);
      dom.innerHTML = linkedHtml;
      console.log(`  - Footnote linking complete: ${footnotes.length} footnotes`);
    }
  }
  /**
   * Cleanup DOM (remove empty elements, strip attributes, etc.)
   * @param {HTMLElement} dom - DOM element
   */
  cleanup(dom) {
    unwrapNonContentContainers(dom);
    removeEmptyBlocks(dom);
    stripAttributes(dom, "pasted-");
    const spans = Array.from(dom.querySelectorAll("span"));
    spans.forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      span.remove();
    });
    groupInlineElements(dom);
    console.log(`  - Cleanup complete`);
  }
  /**
   * Append extracted footnotes and references back to content as static sections
   * These are added AFTER all interactive processing (linking) is complete
   * No DIV wrappers - only block-level elements like h2 and p
   * Content is already cleaned (styles stripped) during extraction
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Extracted footnotes (already cleaned)
   * @param {Array} references - Extracted references (already cleaned)
   */
  appendStaticSections(dom, footnotes, references) {
    if (footnotes.length === 0 && references.length === 0) return;
    console.log(`  - Appending ${footnotes.length} footnotes and ${references.length} references as static content`);
    if (footnotes.length > 0) {
      const heading = document.createElement("h2");
      heading.textContent = "Notes";
      heading.setAttribute("data-static-content", "footnotes");
      dom.appendChild(heading);
      footnotes.forEach((footnote) => {
        const p = document.createElement("p");
        const contentStartsWithNumberDot = visuallyStartsWith(
          footnote.content,
          `${footnote.originalIdentifier}.`
        );
        const contentStartsWithNumberSpace = visuallyStartsWith(
          footnote.content,
          `${footnote.originalIdentifier} `
        );
        const contentStartsWithNumberParen = visuallyStartsWith(
          footnote.content,
          `${footnote.originalIdentifier})`
        );
        if (contentStartsWithNumberDot || contentStartsWithNumberSpace || contentStartsWithNumberParen) {
          p.innerHTML = footnote.content;
        } else {
          p.innerHTML = `${footnote.originalIdentifier}. ${footnote.content}`;
        }
        p.setAttribute("data-static-content", "footnotes");
        dom.appendChild(p);
      });
    }
    if (references.length > 0) {
      const heading = document.createElement("h2");
      heading.textContent = "References";
      heading.setAttribute("data-static-content", "bibliography");
      dom.appendChild(heading);
      references.forEach((reference) => {
        const p = document.createElement("p");
        p.innerHTML = reference.content;
        p.setAttribute("data-static-content", "bibliography");
        dom.appendChild(p);
      });
    }
    console.log(`  - Static sections appended successfully`);
  }
  // ========================================================================
  // FORMAT-SPECIFIC STAGES (must be overridden by subclasses)
  // ========================================================================
  /**
   * Extract footnotes from content
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement extractFootnotes()`);
  }
  /**
   * Extract references/bibliography from content
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement extractReferences()`);
  }
  /**
   * Transform document structure (format-specific transformations)
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement transformStructure()`);
  }
  // ========================================================================
  // HELPER METHODS (available to subclasses)
  // ========================================================================
  /**
   * Generate unique footnote ID
   * Format: Fn{timestamp}_{random} (no bookId prefix - matches backend Python processors)
   * @param {string} bookId - Not used, kept for API compatibility
   * @param {string|number} identifier - Footnote identifier (e.g., '1') - now unused, kept for compatibility
   * @returns {string} - Unique footnote ID
   */
  generateFootnoteId(bookId, identifier) {
    const random = Math.random().toString(36).substring(2, 6);
    return `Fn${Date.now()}_${random}`;
  }
  /**
   * Generate footnote reference ID (same as footnote ID - no ref suffix needed)
   * @param {string} footnoteId - The footnote ID to use
   * @returns {string} - Same as footnoteId (ref suffix removed)
   * @deprecated Use footnoteId directly instead
   */
  generateFootnoteRefId(footnoteId, ...rest) {
    return footnoteId;
  }
  /**
   * Create footnote object with standard structure
   * @param {string} footnoteId - Unique footnote ID
   * @param {string} content - Footnote content (HTML)
   * @param {string|number} originalIdentifier - Original identifier from source
   * @param {string} refId - Reference ID (now same as footnoteId, kept for compatibility)
   * @param {string} type - Type of footnote (e.g., 'html-paragraph-heuristic')
   * @returns {Object} - Footnote object
   */
  createFootnote(footnoteId, content, originalIdentifier, refId, type) {
    return {
      footnoteId,
      content,
      originalIdentifier: String(originalIdentifier),
      refId: footnoteId,
      // Use footnoteId directly - ref suffix no longer needed
      type
    };
  }
  /**
   * Create reference object with standard structure
   * @param {string} referenceId - Unique reference ID
   * @param {string} content - Reference content (HTML)
   * @param {string} originalText - Original text for key generation
   * @param {string} type - Type of reference
   * @param {Array<string>} refKeys - Reference keys for lookup
   * @returns {Object} - Reference object
   */
  createReference(referenceId, content, originalText, type, refKeys = []) {
    return {
      referenceId,
      content,
      originalText,
      type,
      refKeys
    };
  }
};

// resources/js/paste/format-processors/general-processor.ts
var GeneralProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("general");
  }
  /**
   * Extract footnotes using heuristic pattern matching
   * Looks for:
   * - <sup> tags with numeric content
   * - Paragraphs starting with "N. " or "N) "
   * - Markdown-style footnotes [^N]
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = /* @__PURE__ */ new Map();
    const refIdentifiers = /* @__PURE__ */ new Set();
    const supElements = dom.querySelectorAll("sup");
    supElements.forEach((sup) => {
      const identifier = sup.textContent.trim() || sup.getAttribute("fn-count-id");
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);
      }
    });
    const anchorLinks = dom.querySelectorAll("a[href]");
    anchorLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
      if (fragmentMatch) {
        refIdentifiers.add(fragmentMatch[1]);
      }
    });
    console.log(`  - Found ${refIdentifiers.size} footnote references (from <sup> and anchor links)`);
    const potentialParagraphDefs = /* @__PURE__ */ new Map();
    dom.querySelectorAll("p").forEach((p) => {
      const pText = p.textContent.trim();
      const match = pText.match(/^(\d+)[\.)\s:]/);
      if (match && pText.length > match[0].length) {
        potentialParagraphDefs.set(match[1], p);
      }
    });
    console.log(`  - Found ${potentialParagraphDefs.size} potential paragraph definitions`);
    if (refIdentifiers.size > 0) {
      const liDefsFound = [];
      dom.querySelectorAll("li").forEach((li) => {
        const firstAnchor = li.querySelector("a");
        if (firstAnchor) {
          const anchorText = firstAnchor.textContent.trim();
          if (/^\d+$/.test(anchorText) && refIdentifiers.has(anchorText) && !potentialParagraphDefs.has(anchorText)) {
            potentialParagraphDefs.set(anchorText, li);
            liDefsFound.push(anchorText);
            return;
          }
        }
        const liText = li.textContent.trim();
        const match = liText.match(/^(\d+)[\.)\s:]/);
        if (match && liText.length > match[0].length && refIdentifiers.has(match[1]) && !potentialParagraphDefs.has(match[1])) {
          potentialParagraphDefs.set(match[1], li);
          liDefsFound.push(match[1]);
        }
      });
      if (liDefsFound.length > 0) {
        console.log(`  - Found ${liDefsFound.length} additional definitions in <li> elements`);
      }
    }
    if (refIdentifiers.size > 0) {
      const anchorDefsFound = [];
      dom.querySelectorAll('a[name^="fn"], a[name^="ftn"], a[name^="_ftn"], a[name^="note"], a[name^="_edn"]').forEach((anchor) => {
        const name = anchor.getAttribute("name");
        const numMatch = name.match(/(\d+)/);
        if (numMatch && refIdentifiers.has(numMatch[1]) && !potentialParagraphDefs.has(numMatch[1])) {
          const container = anchor.closest("p, li, div");
          if (container) {
            potentialParagraphDefs.set(numMatch[1], container);
            anchorDefsFound.push(numMatch[1]);
          }
        }
      });
      if (anchorDefsFound.length > 0) {
        console.log(`  - Found ${anchorDefsFound.length} additional definitions via anchor names`);
      }
    }
    let allRefsHaveDefs = refIdentifiers.size > 0;
    for (const refId of refIdentifiers) {
      if (!potentialParagraphDefs.has(refId)) {
        allRefsHaveDefs = false;
        console.log(`  - \u26A0\uFE0F Reference ${refId} has no matching definition`);
        break;
      }
    }
    if (allRefsHaveDefs && refIdentifiers.size > 0) {
      console.log(`  - \u2705 All references have definitions, extracting footnotes`);
      for (const identifier of refIdentifiers) {
        const pElement = potentialParagraphDefs.get(identifier);
        if (!pElement) continue;
        const content = pElement.innerHTML.trim().replace(/^\s*<a[^>]*>\s*\d+\s*<\/a>\s*/, "").replace(/^\s*\d+[\.)]\s*/, "");
        const uniqueId = this.generateFootnoteId(bookId, identifier);
        const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);
        footnotes.push(this.createFootnote(
          uniqueId,
          content,
          identifier,
          uniqueRefId,
          "html-paragraph-heuristic"
        ));
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
        const parentList = pElement.parentElement;
        pElement.remove();
        if (parentList && (parentList.tagName === "UL" || parentList.tagName === "OL") && parentList.children.length === 0) {
          parentList.remove();
        }
      }
    } else {
      console.log(`  - \u2139\uFE0F Heuristic extraction skipped (not all refs have defs or no refs found)`);
    }
    const allParagraphs = dom.querySelectorAll("p");
    allParagraphs.forEach((p) => {
      const text = p.textContent.trim();
      const markdownFootnoteMatch = text.match(/^\[\^?(\d+)\]\s*:\s*(.+)$/s);
      if (markdownFootnoteMatch) {
        const identifier = markdownFootnoteMatch[1];
        const content = markdownFootnoteMatch[2].trim();
        if (!footnoteMappings.has(identifier)) {
          const uniqueId = this.generateFootnoteId(bookId, identifier);
          const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);
          const processedContent = p.innerHTML.replace(/^\[\^?\d+\]\s*:\s*/, "");
          footnotes.push(this.createFootnote(
            uniqueId,
            processedContent,
            identifier,
            uniqueRefId,
            "markdown-html"
          ));
          footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
          p.remove();
        }
      }
    });
    return footnotes;
  }
  /**
   * Extract references - prioritizes anchor-based detection over heuristics
   * Strategy:
   * 1. Find all paragraphs with <a name="ref..."> anchors - these ARE the references
   * 2. Only fall back to heuristics if no anchor-based refs found
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    const anchorRefs = dom.querySelectorAll('a[name^="ref"]');
    if (anchorRefs.length > 0) {
      console.log(`  - \u{1F3AF} Found ${anchorRefs.length} anchor-based references (using anchor detection)`);
      anchorRefs.forEach((anchor) => {
        const container = anchor.closest("p, li, div");
        if (!container) return;
        const ref = {
          content: container.outerHTML,
          originalText: container.textContent.trim(),
          type: "anchor-based",
          needsKeyGeneration: true,
          originalAnchorId: anchor.getAttribute("name")
        };
        references.push(ref);
      });
      console.log(`  - Extracted ${references.length} anchor-based references`);
      return references;
    }
    console.log(`  - No anchor-based references found, using heuristic detection`);
    const allElements = Array.from(dom.children);
    let referenceSectionStartIndex = -1;
    const refHeadings = /^(references|bibliography|works cited|sources)$/i;
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
        referenceSectionStartIndex = i;
        console.log(`  - Found reference section at index ${i}: "${el.textContent.trim()}"`);
        break;
      }
    }
    const looksLikeReferenceStart = (text) => {
      if (!text || text.length < 10) return false;
      const trimmed = text.trim();
      const startsWithAuthor = /^[A-ZÖÄÜÉÈÊËÀÂÎÏÔÛÇ]/.test(trimmed);
      const startsWithNumber = /^\[\d+\]/.test(trimmed);
      const hasYear = /\d{4}/.test(trimmed);
      return (startsWithAuthor || startsWithNumber) && hasYear;
    };
    const extractRefsFromParagraph = (p, isInRefSection2) => {
      const extracted = [];
      const html = p.innerHTML;
      if (/<br\b[^>]*>/i.test(html)) {
        const parts = html.split(/<br\b[^>]*>/i).map((s) => s.trim()).filter((s) => s);
        const refLikeParts = parts.filter((part) => {
          const temp = document.createElement("div");
          temp.innerHTML = part;
          return looksLikeReferenceStart(temp.textContent);
        });
        if (isInRefSection2 || refLikeParts.length >= parts.length * 0.7) {
          parts.forEach((part) => {
            const temp = document.createElement("div");
            temp.innerHTML = part;
            const text2 = temp.textContent.trim();
            if (looksLikeReferenceStart(text2)) {
              const ref = {
                content: `<p>${part}</p>`,
                originalText: text2,
                type: "html-br-split",
                needsKeyGeneration: true
              };
              extracted.push(ref);
            }
          });
          if (extracted.length > 0) {
            console.log(`  - Split paragraph into ${extracted.length} references (was <br>-separated)`);
            return extracted;
          }
        }
      }
      const text = p.textContent.trim();
      if (looksLikeReferenceStart(text)) {
        const ref = {
          content: p.outerHTML,
          originalText: text,
          type: "html-paragraph",
          needsKeyGeneration: true
        };
        extracted.push(ref);
      }
      return extracted;
    };
    let elementsToScan = [];
    let isInRefSection = false;
    if (referenceSectionStartIndex !== -1) {
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter((el) => el.tagName === "P");
      isInRefSection = true;
    } else {
      elementsToScan = Array.from(dom.querySelectorAll("p")).reverse();
    }
    console.log(`  - Scanning ${elementsToScan.length} potential reference paragraphs`);
    const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;
    elementsToScan.forEach((p) => {
      const text = p.textContent.trim();
      if (!text) return;
      if (!isInRefSection) {
        const citeMatch = text.match(inTextCitePattern);
        if (citeMatch) {
          const content = citeMatch[1];
          if (content.includes(",") || /[a-zA-Z]{2,}.*\d{4}/.test(content)) {
            return;
          }
        }
      }
      const refs = extractRefsFromParagraph(p, isInRefSection);
      references.push(...refs);
    });
    console.log(`  - Extracted ${references.length} potential references`);
    return references;
  }
  /**
   * Transform structure: wrap loose nodes and unwrap unnecessary containers
   * This is the "Structure Preserving" strategy from parseGeneralContent()
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log(`  - Applying general structure transformation`);
    const containers = Array.from(
      dom.querySelectorAll("div, article, section, main, header, footer, aside, nav, button")
    );
    containers.reverse().forEach((container) => {
      wrapLooseNodes(container);
      unwrap(container);
    });
    dom.querySelectorAll("font").forEach(unwrap);
    console.log(`  - Unwrapped ${containers.length} containers`);
    wrapLooseNodes(dom);
    console.log(`  - Wrapped loose inline elements at top level`);
  }
};

// resources/js/paste/utils/transform-helpers.ts
function unwrapContainers(dom, additionalSelectors = "") {
  const baseSelectors = "div, article, section, main, header, footer, aside, nav, button";
  const selectors = additionalSelectors ? `${baseSelectors}, ${additionalSelectors}` : baseSelectors;
  const containers = Array.from(dom.querySelectorAll(selectors));
  containers.reverse().forEach((container) => {
    wrapLooseNodes(container);
    unwrap(container);
  });
  dom.querySelectorAll("font").forEach(unwrap);
}
function removeSectionsByHeading(dom, headingMatcher = isReferenceSectionHeading) {
  const headings = dom.querySelectorAll("h1, h2, h3, h4, h5, h6");
  let removedCount = 0;
  headings.forEach((heading) => {
    if (headingMatcher(heading.textContent.trim())) {
      let nextElement = heading.nextElementSibling;
      heading.remove();
      removedCount++;
      while (nextElement) {
        const next = nextElement.nextElementSibling;
        if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
          break;
        }
        nextElement.remove();
        nextElement = next;
      }
    }
  });
  return removedCount;
}
function removeStaticContentElements(dom) {
  const staticElements = dom.querySelectorAll("[data-static-content]");
  const count = staticElements.length;
  staticElements.forEach((el) => el.remove());
  return count;
}
function cloneAndClean(element, selectorsToRemove = []) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
  if (selectorsToRemove.length > 0) {
    clone.querySelectorAll(selectorsToRemove.join(", ")).forEach((el) => el.remove());
  }
  return clone;
}
function isValidReference(text, options = {}) {
  const { minLength = 20, maxYearPosition = 150 } = options;
  if (!text || text.length < minLength) {
    return false;
  }
  const yearMatch = text.match(/\d{4}[a-z]?/);
  return yearMatch && yearMatch.index < maxYearPosition;
}
function addUniqueReference(references, newRef, keyField = "originalText") {
  if (!references.find((r) => r[keyField] === newRef[keyField])) {
    references.push(newRef);
    return true;
  }
  return false;
}
function reformatCitationLink(link, { author = "", year = "", isNarrative = false, trailing = "" }) {
  if (!year) return;
  if (isNarrative) {
    if (author) {
      const authorText = document.createTextNode(author + " ");
      link.parentNode.insertBefore(authorText, link);
    }
    const openBracket = document.createTextNode("(");
    link.parentNode.insertBefore(openBracket, link);
    link.textContent = year;
    const closeBracket = document.createTextNode(")");
    link.parentNode.insertBefore(closeBracket, link.nextSibling);
  } else {
    if (author) {
      const authorText = document.createTextNode(author);
      link.parentNode.insertBefore(authorText, link);
    }
    link.textContent = year;
    if (trailing) {
      const trailingText = document.createTextNode(trailing);
      link.parentNode.insertBefore(trailingText, link.nextSibling);
    }
  }
}
function cleanTFFootnoteContent(htmlContent) {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = htmlContent;
  tempDiv.querySelectorAll("span.ref-lnk").forEach((span) => {
    while (span.firstChild) {
      span.parentNode.insertBefore(span.firstChild, span);
    }
    span.remove();
  });
  tempDiv.querySelectorAll('a[data-rid^="CIT"]').forEach((link) => {
    link.querySelectorAll("span.off-screen").forEach((s) => s.remove());
    link.removeAttribute("data-behaviour");
    link.removeAttribute("data-ref-type");
    link.removeAttribute("data-label");
    link.removeAttribute("data-registered");
    link.removeAttribute("href");
  });
  return tempDiv.innerHTML;
}

// resources/js/paste/format-processors/cambridge-processor.ts
var CambridgeProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("cambridge");
  }
  /**
   * Extract footnotes from Cambridge-specific structure
   * Cambridge footnotes have a complex nested structure that needs normalization
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = /* @__PURE__ */ new Map();
    console.log("\u{1F4DA} Cambridge: Initial structure check:");
    console.log("  - .xref.fn links:", dom.querySelectorAll(".xref.fn").length);
    console.log("  - reference-*-content divs:", dom.querySelectorAll('[id^="reference-"][id$="-content"]').length);
    console.log("  - circle-list items:", dom.querySelectorAll(".circle-list__item").length);
    console.log("  - fn* divs:", dom.querySelectorAll('div[id^="fn"]').length);
    const footnoteLinks = dom.querySelectorAll('.xref.fn, a[href^="#fn"]');
    console.log(`\u{1F4DA} Cambridge: Found ${footnoteLinks.length} in-text footnote links`);
    footnoteLinks.forEach((link, index) => {
      const sup = link.querySelector("sup");
      if (sup) {
        const identifier = sup.textContent.trim();
        const cleanSup = createFootnoteSupElement("", identifier);
        cleanSup.removeAttribute("id");
        link.replaceWith(cleanSup);
      }
    });
    const footnoteContainers = dom.querySelectorAll('[id^="reference-"][id$="-content"]');
    console.log(`\u{1F4DA} Cambridge: Found ${footnoteContainers.length} footnote definition containers`);
    footnoteContainers.forEach((container, index) => {
      const idMatch = container.id.match(/reference-(\d+)-content/);
      if (!idMatch) {
        console.log(`\u{1F4DA} Cambridge: Container ${index + 1} has no ID pattern`);
        return;
      }
      const footnoteNum = idMatch[1];
      const paragraph = container.querySelector("p.p, p");
      if (!paragraph) {
        return;
      }
      const cleanParagraph = paragraph.cloneNode(true);
      const labelSpan = cleanParagraph.querySelector("span.label");
      if (labelSpan) labelSpan.remove();
      const content = cleanParagraph.innerHTML.trim();
      const uniqueId = this.generateFootnoteId(bookId, footnoteNum);
      const uniqueRefId = this.generateFootnoteRefId(bookId, footnoteNum);
      footnotes.push(this.createFootnote(
        uniqueId,
        content,
        // Just the content, no number prefix
        footnoteNum,
        uniqueRefId,
        "cambridge-normalized"
      ));
      footnoteMappings.set(footnoteNum, { uniqueId, uniqueRefId });
      const simpleParagraph = document.createElement("p");
      simpleParagraph.innerHTML = `${footnoteNum}. ${content}`;
      container.replaceWith(simpleParagraph);
      simpleParagraph.remove();
    });
    const circleListContainers = dom.querySelectorAll(".circle-list__item, .circle-list");
    let removedCircleLists = 0;
    circleListContainers.forEach((container) => {
      const innerRefs = container.querySelectorAll('[id^="reference-"][id$="-content"]');
      const hasUnextractedCsl = Array.from(innerRefs).some((c) => !c.querySelector("p.p, p"));
      if (hasUnextractedCsl) return;
      container.remove();
      removedCircleLists++;
    });
    console.log(`\u{1F4DA} Cambridge: Removed ${removedCircleLists} circle-list containers`);
    const fnDivs = dom.querySelectorAll('div[id^="fn"]');
    fnDivs.forEach((div) => div.remove());
    console.log(`\u{1F4DA} Cambridge: Removed ${fnDivs.length} fn* divs`);
    console.log(`\u{1F4DA} Cambridge: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Extract and preserve main title/heading
   * Cambridge articles have h1/h2 titles that shouldn't be lost
   *
   * @param {HTMLElement} dom - DOM element
   * @returns {HTMLElement|null} - Extracted title element or null
   */
  extractAndPreserveTitle(dom) {
    const potentialTitles = dom.querySelectorAll("h1, h2");
    for (const heading of potentialTitles) {
      const text = heading.textContent.trim();
      if (/^(references|bibliography|notes|footnotes|abstract|introduction)$/i.test(text)) {
        continue;
      }
      if (text.length > 20) {
        console.log(`\u{1F4DA} Cambridge: Preserved title: "${text.substring(0, 60)}..."`);
        const titleClone = heading.cloneNode(true);
        heading.remove();
        return titleClone;
      }
    }
    return null;
  }
  /**
   * Extract references from Cambridge content
   * Uses stricter filtering to avoid extracting body text as references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} Cambridge: Using improved reference extraction");
    const cslContainers = Array.from(
      dom.querySelectorAll('[id^="reference-"][id$="-content"]')
    ).filter((c) => !c.querySelector("p.p, p"));
    if (cslContainers.length) {
      console.log(`\u{1F4DA} Cambridge: Found ${cslContainers.length} author-date CSL reference container(s)`);
    }
    cslContainers.forEach((container) => {
      const text = container.textContent.replace(/\s+/g, " ").trim();
      if (!text) return;
      references.push({
        content: container.innerHTML,
        originalText: text,
        type: "cambridge-reference",
        needsKeyGeneration: true
      });
      container.remove();
    });
    const refHeadings = /^(references|bibliography|works cited)$/i;
    const headings = Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const referenceHeading = headings.find((h) => refHeadings.test(h.textContent.trim()));
    if (!referenceHeading) {
      console.log("\u{1F4DA} Cambridge: No References/Bibliography heading found, skipping reference extraction");
      return references;
    }
    const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;
    const elementsToScan = Array.from(dom.querySelectorAll("p")).filter(
      (p) => referenceHeading.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    elementsToScan.forEach((p) => {
      const text = p.textContent.trim();
      if (!text) return;
      const citeMatch = text.match(inTextCitePattern);
      if (citeMatch) {
        const content = citeMatch[1];
        if (content.includes(",") || content.includes(":") || /[a-zA-Z]{2,}/.test(content)) {
          return;
        }
      }
      const yearMatch = text.match(/(\d{4}[a-z]?)/);
      if (!yearMatch || yearMatch.index > 150) {
        return;
      }
      if (text.length < 30 || !text.includes(".")) {
        return;
      }
      references.push({
        content: p.outerHTML,
        originalText: text,
        type: "cambridge-reference",
        needsKeyGeneration: true
      });
    });
    console.log(`\u{1F4DA} Cambridge: Extracted ${references.length} references`);
    return references;
  }
  /**
   * Transform document structure
   * Aggressive cleanup to remove Vue components and Cambridge-specific structures
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} Cambridge: Applying aggressive structure transformation");
    const title = this.extractAndPreserveTitle(dom);
    const appButtons = dom.querySelectorAll("appbutton");
    appButtons.forEach((el) => el.remove());
    console.log(`\u{1F4DA} Cambridge: Removed ${appButtons.length} <appbutton> Vue components`);
    const vueImages = dom.querySelectorAll("img[data-v-d2c09870], img[data-v-2a038744]");
    vueImages.forEach((el) => el.remove());
    console.log(`\u{1F4DA} Cambridge: Removed ${vueImages.length} Vue icon images`);
    const cambridgeStructural = dom.querySelectorAll(".circle-list, .circle-list__item, .circle-list__item__indicator, .circle-list__item__number, .circle-list__item__grouped, .circle-list__item__grouped__content");
    cambridgeStructural.forEach((el) => el.remove());
    console.log(`\u{1F4DA} Cambridge: Removed ${cambridgeStructural.length} Cambridge structural containers`);
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} Cambridge: Removed ${removedSections + removedStatic} section(s) from main content`);
    unwrapContainers(dom);
    if (title) {
      dom.insertBefore(title, dom.firstChild);
      console.log("\u{1F4DA} Cambridge: Title re-inserted at start of content");
    }
    console.log("\u{1F4DA} Cambridge: Transformation complete");
  }
  /**
   * Override linkFootnotes to convert simplified <sup> tags to proper linked footnotes
   * Cambridge creates <sup fn-count-id="N">N</sup> during extraction
   * Need to convert to <sup id="refId" fn-count-id="N" class="footnote-ref">N</sup>
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`\u{1F4DA} Cambridge: Linking ${footnotes.length} footnotes to in-text references`);
    const supTags = dom.querySelectorAll("sup[fn-count-id]");
    let linkedCount = 0;
    supTags.forEach((sup) => {
      const identifier = sup.getAttribute("fn-count-id");
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
      if (footnote) {
        const newSup = createFootnoteSupElement(footnote.refId, identifier);
        sup.replaceWith(newSup);
        linkedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Cambridge: Could not find footnote for identifier ${identifier}`);
      }
    });
    console.log(`  - Linked ${linkedCount} Cambridge footnote references`);
  }
};

// resources/js/paste/format-processors/taylor-francis-processor.ts
var TaylorFrancisProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("taylor-francis");
    this.extractedReferences = [];
    this.citIdToRefMap = /* @__PURE__ */ new Map();
  }
  /**
   * Extract footnotes from Taylor & Francis structure
   * Looks for Notes headings and summation-section divs
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const notesHeadings = dom.querySelectorAll("h1, h2, h3, h4, h5, h6");
    notesHeadings.forEach((heading) => {
      if (/notes/i.test(heading.textContent.trim()) || heading.id === "inline_frontnotes") {
        let nextElement = heading.nextElementSibling;
        while (nextElement) {
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            break;
          }
          if (nextElement.tagName === "P") {
            const pText = nextElement.textContent.trim();
            const match = pText.match(/^\[?(\d+)\]?[\.\)\s]/);
            if (match) {
              const identifier = match[1];
              nextElement.classList.add("footnote");
              let htmlContent = nextElement.innerHTML.trim();
              htmlContent = htmlContent.replace(/^\s*<sup[^>]*>\s*\d+\s*<\/sup>\s*/i, "").replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, "").replace(/^\s*\[\d+\]\s*/, "");
              htmlContent = cleanTFFootnoteContent(htmlContent);
              footnotes.push(this.createFootnote(
                this.generateFootnoteId(bookId, identifier),
                htmlContent,
                // Don't add identifier prefix - it's already in the content
                identifier,
                this.generateFootnoteRefId(bookId, identifier),
                "taylor-francis"
              ));
            }
          } else if (nextElement.tagName === "DIV") {
            const divHasFootnoteId = nextElement.id && /^(EN|FN)/i.test(nextElement.id);
            if (divHasFootnoteId) {
              const footnoteRid = nextElement.id;
              const paragraphs = nextElement.querySelectorAll("p");
              paragraphs.forEach((p) => {
                const pText = p.textContent.trim();
                const match = pText.match(/^\[?(\d+)\]?[\.\)\s]/);
                if (match) {
                  const identifier = match[1];
                  p.classList.add("footnote");
                  let htmlContent = p.innerHTML.trim();
                  htmlContent = htmlContent.replace(/^\s*<sup[^>]*>\s*\d+\s*<\/sup>\s*/i, "").replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, "").replace(/^\s*\[\d+\]\s*/, "");
                  htmlContent = cleanTFFootnoteContent(htmlContent);
                  const footnote = this.createFootnote(
                    this.generateFootnoteId(bookId, identifier),
                    // Always use standard ID
                    htmlContent,
                    // Don't add identifier prefix
                    identifier,
                    this.generateFootnoteRefId(bookId, identifier),
                    "taylor-francis"
                  );
                  const upperRid = footnoteRid.toUpperCase();
                  if (upperRid.startsWith("EN")) {
                    footnote.enId = footnoteRid;
                  } else if (upperRid.startsWith("FN")) {
                    footnote.fnId = footnoteRid;
                  }
                  footnotes.push(footnote);
                }
              });
            } else {
              const childDivs = nextElement.querySelectorAll('div[id^="EN"], div[id^="FN"], div[id^="en"], div[id^="fn"]');
              childDivs.forEach((childDiv) => {
                const footnoteRid = childDiv.id;
                const paragraphs = childDiv.querySelectorAll("p");
                paragraphs.forEach((p) => {
                  const pText = p.textContent.trim();
                  const match = pText.match(/^\[?(\d+)\]?[\.\)\s]/);
                  if (match) {
                    const identifier = match[1];
                    p.classList.add("footnote");
                    let htmlContent = p.innerHTML.trim();
                    htmlContent = htmlContent.replace(/^\s*<sup[^>]*>\s*\d+\s*<\/sup>\s*/i, "").replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, "").replace(/^\s*\[\d+\]\s*/, "");
                    htmlContent = cleanTFFootnoteContent(htmlContent);
                    const footnote = this.createFootnote(
                      this.generateFootnoteId(bookId, identifier),
                      // Always use standard ID
                      htmlContent,
                      // Don't add identifier prefix
                      identifier,
                      this.generateFootnoteRefId(bookId, identifier),
                      "taylor-francis"
                    );
                    const upperRid = footnoteRid.toUpperCase();
                    if (upperRid.startsWith("EN")) {
                      footnote.enId = footnoteRid;
                    } else if (upperRid.startsWith("FN")) {
                      footnote.fnId = footnoteRid;
                    }
                    footnotes.push(footnote);
                  }
                });
              });
            }
          }
          nextElement = nextElement.nextElementSibling;
        }
      }
    });
    const summationSections = dom.querySelectorAll('.summation-section, div[id^="EN"], div[id^="FN"], div[id^="en"], div[id^="fn"]');
    summationSections.forEach((section) => {
      const footnoteRid = section.id;
      const paragraphs = section.querySelectorAll("p");
      paragraphs.forEach((p) => {
        const pText = p.textContent.trim();
        const match = pText.match(/^\[?(\d+)\]?[\.\)\s]/);
        if (match) {
          const identifier = match[1];
          p.classList.add("footnote");
          if (!footnotes.find((fn) => fn.originalIdentifier === identifier)) {
            let htmlContent = p.innerHTML.trim();
            htmlContent = htmlContent.replace(/^\s*<sup[^>]*>\s*\d+\s*<\/sup>\s*/i, "").replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, "").replace(/^\s*\[\d+\]\s*/, "");
            htmlContent = cleanTFFootnoteContent(htmlContent);
            const footnote = this.createFootnote(
              this.generateFootnoteId(bookId, identifier),
              // Always use standard ID
              htmlContent,
              // Don't add identifier prefix
              identifier,
              this.generateFootnoteRefId(bookId, identifier),
              "taylor-francis"
            );
            const upperRid = footnoteRid ? footnoteRid.toUpperCase() : "";
            if (upperRid.startsWith("EN")) {
              footnote.enId = footnoteRid;
            } else if (upperRid.startsWith("FN")) {
              footnote.fnId = footnoteRid;
            }
            footnotes.push(footnote);
          }
        }
      });
    });
    console.log(`\u{1F4DD} T&F: Extracted ${footnotes.length} footnotes`);
    return footnotes;
  }
  /**
   * Extract references from Taylor & Francis bibliography
   * Matches OLD code structure from footnoteReferenceExtractor.js
   */
  async extractReferences(dom, bookId) {
    const references = [];
    const citItems = dom.querySelectorAll('li[id^="CIT"]');
    if (citItems.length > 0) {
      citItems.forEach((item) => {
        const citId = item.id;
        const clone = cloneAndClean(item, [".extra-links"]);
        const content = clone.textContent.trim();
        if (content && content.length > 10) {
          const reference = {
            content,
            originalText: content,
            type: "taylor-francis-cit",
            needsKeyGeneration: true,
            citId
            // Store the CIT ID for linking
          };
          references.push(reference);
          this.citIdToRefMap.set(citId, reference);
        }
      });
    }
    if (references.length === 0) {
      const headings = dom.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const heading of headings) {
        if (/references|bibliography/i.test(heading.textContent.trim())) {
          let nextElement = heading.nextElementSibling;
          while (nextElement) {
            if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
              break;
            }
            if (nextElement.tagName === "DIV" || nextElement.tagName === "SECTION" || nextElement.tagName === "UL" || nextElement.tagName === "OL") {
              const refItems = nextElement.querySelectorAll("li, p");
              refItems.forEach((item) => {
                const clone = cloneAndClean(item, [".extra-links"]);
                const content = clone.textContent.trim();
                if (content && content.length > 10) {
                  addUniqueReference(references, {
                    content,
                    originalText: content,
                    type: "taylor-francis-list",
                    needsKeyGeneration: true
                  }, "content");
                }
              });
            }
            nextElement = nextElement.nextElementSibling;
          }
        }
      }
    }
    console.log(`\u{1F4DA} T&F: Extracted ${references.length} references`);
    this.extractedReferences = references;
    return references;
  }
  /**
   * Override linkCitations to handle T&F-specific data-rid links
   * After base class generates reference IDs, convert data-rid links to href links
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    const citationLinks = dom.querySelectorAll('a[data-rid^="CIT"]');
    let convertedCount = 0;
    citationLinks.forEach((link) => {
      const citId = link.getAttribute("data-rid");
      const reference = this.citIdToRefMap.get(citId);
      if (reference && reference.referenceId) {
        link.setAttribute("href", `#${reference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        link.removeAttribute("data-rid");
        link.removeAttribute("data-behaviour");
        link.removeAttribute("data-ref-type");
        link.removeAttribute("data-label");
        link.removeAttribute("data-registered");
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F T&F: Could not find reference for ${citId}`);
      }
    });
    console.log(`  - Converted ${convertedCount} T&F citation links`);
  }
  /**
   * Override linkFootnotes to handle T&F-specific data-rid footnote links
   */
  linkFootnotes(dom, footnotes) {
    const footnoteLinks = dom.querySelectorAll(
      'a[data-rid^="EN"], a[data-rid^="FN"], a[data-rid^="en"], a[data-rid^="fn"], a[data-behaviour-ref^="#EN"], a[data-behaviour-ref^="#FN"], a[data-behaviour-ref^="#en"], a[data-behaviour-ref^="#fn"]'
    );
    let convertedCount = 0;
    footnoteLinks.forEach((link) => {
      let footnoteRid = link.getAttribute("data-rid");
      if (!footnoteRid) {
        const behaviourRef = link.getAttribute("data-behaviour-ref");
        if (behaviourRef) {
          footnoteRid = behaviourRef.replace(/^#/, "");
        }
      }
      if (!footnoteRid) return;
      const upperRid = footnoteRid.toUpperCase();
      let footnote = footnotes.find(
        (fn) => fn.enId && fn.enId.toUpperCase() === upperRid || fn.fnId && fn.fnId.toUpperCase() === upperRid
      );
      if (!footnote) {
        const numberMatch = footnoteRid.match(/\d+$/);
        if (numberMatch) {
          const num = String(parseInt(numberMatch[0], 10));
          footnote = footnotes.find((fn) => fn.originalIdentifier === num);
        }
      }
      if (footnote) {
        const supElement = link.querySelector("sup");
        let identifier = supElement ? supElement.textContent.trim() : footnote.originalIdentifier;
        if (!identifier || identifier === "") {
          console.warn(`\u26A0\uFE0F T&F: Empty identifier for ${footnoteRid}, using originalIdentifier: ${footnote.originalIdentifier}`);
          identifier = footnote.originalIdentifier;
        }
        const newSup = createFootnoteSupElement(footnote.refId, identifier);
        link.parentNode.replaceChild(newSup, link);
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F T&F: Could not find footnote for ${footnoteRid}`);
      }
    });
    console.log(`  - Converted ${convertedCount} T&F footnote links`);
  }
  /**
   * Transform structure - unwrap divs and clean up
   */
  async transformStructure(dom, bookId) {
    dom.querySelectorAll(".extra-links").forEach((el) => el.remove());
    const citationLinks = dom.querySelectorAll('a[data-rid^="CIT"]');
    citationLinks.forEach((link) => {
      const textContent = link.textContent;
      const cleanText = textContent.replace(/^Citation/i, "");
      link.textContent = cleanText;
    });
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} T&F: Removed ${removedSections + removedStatic} section(s) from main content`);
    const tfWrapperSpans = Array.from(dom.querySelectorAll("span.ref-lnk"));
    tfWrapperSpans.forEach((span) => {
      unwrap(span);
    });
    unwrapContainers(dom);
  }
};

// resources/js/paste/format-processors/oup-processor.ts
var OupProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("oup");
  }
  /**
   * Extract footnotes from OUP structure
   * OUP uses <div class="footnote" content-id="fn1"> for footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    console.log("\u{1F4DA} OUP: Looking for footnotes with content-id attributes");
    const footnoteElements = dom.querySelectorAll('.footnote[content-id^="fn"], [content-id^="fn"]');
    console.log(`\u{1F4DA} OUP: Found ${footnoteElements.length} footnote elements`);
    footnoteElements.forEach((element) => {
      const contentId = element.getAttribute("content-id");
      const inTableContext = element.closest(".table-wrap-foot, .table-wrap, table");
      const inFigureContext = element.closest(".fig, .fig-section, figure");
      if (inTableContext || inFigureContext) {
        console.log(`\u{1F4DA} OUP: Skipping ${contentId} (in ${inTableContext ? "table" : "figure"} context, will stay in body)`);
        return;
      }
      const identifierMatch = contentId.match(/fn-?(\d+)/);
      if (!identifierMatch) {
        console.warn(`\u26A0\uFE0F OUP: Could not extract identifier from content-id: ${contentId}`);
        return;
      }
      const identifier = parseInt(identifierMatch[1], 10).toString();
      const contentClone = element.cloneNode(true);
      contentClone.querySelectorAll('a[href*="#fn"], .footnote-label, .label').forEach((el) => el.remove());
      let contentElement = contentClone.querySelector(".footnote-content p, p.footnote-compatibility, p");
      if (!contentElement) {
        contentElement = contentClone;
        console.warn(`\u26A0\uFE0F OUP: No content paragraph found for footnote ${identifier}, using entire element`);
      }
      contentElement.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
      const htmlContent = contentElement.innerHTML.trim();
      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          "oup"
        );
        footnote.contentId = contentId;
        footnotes.push(footnote);
        console.log(`\u{1F4DA} OUP: Extracted footnote ${identifier} (${contentId}): "${htmlContent.substring(0, 50)}..."`);
        element.remove();
      }
    });
    console.log(`\u{1F4DA} OUP: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Link footnotes to in-text references
   * OUP uses <a reveal-id="fn*"> for footnote references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`\u{1F4DA} OUP: Linking ${footnotes.length} footnotes to in-text references`);
    const fnLinks = dom.querySelectorAll('a[reveal-id^="fn"], a[data-open^="fn"]');
    let linkedCount = 0;
    fnLinks.forEach((link) => {
      const revealId = link.getAttribute("reveal-id") || link.getAttribute("data-open");
      const identifierMatch = revealId.match(/fn-?(\d+)/);
      if (!identifierMatch) {
        console.warn(`\u26A0\uFE0F OUP: Could not extract identifier from reveal-id: ${revealId}`);
        return;
      }
      const identifier = parseInt(identifierMatch[1], 10).toString();
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
      if (footnote) {
        const newSup = createFootnoteSupElement(footnote.refId, identifier);
        const parentSup = link.parentElement;
        if (parentSup && parentSup.tagName === "SUP") {
          parentSup.replaceWith(newSup);
        } else {
          link.replaceWith(newSup);
        }
        linkedCount++;
      } else {
        console.warn(`\u26A0\uFE0F OUP: Could not find footnote for identifier ${identifier}`);
      }
    });
    console.log(`  - Linked ${linkedCount} OUP footnote references`);
  }
  /**
   * Extract references from OUP bibliography
   * OUP uses content-id="bib*" for bibliography entries
   * Special handling: bibliography format is "Surname Firstname"
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} OUP: Looking for bibliography items with content-id attributes");
    const bibItems = dom.querySelectorAll('[content-id^="bib"]');
    console.log(`\u{1F4DA} OUP: Found ${bibItems.length} bibliography items`);
    bibItems.forEach((item) => {
      const contentId = item.getAttribute("content-id");
      const fullText = item.textContent.trim();
      if (!fullText || fullText.length < 10) {
        console.warn(`\u26A0\uFE0F OUP: Skipping empty or too short bibliography item: ${contentId}`);
        return;
      }
      let yearMatch = fullText.match(/\((\d{4}[a-z]?)\)/);
      if (!yearMatch) {
        yearMatch = fullText.match(/,\s*[A-Z]\.?\s*(\d{4}[a-z]?)[\.\s]/);
      }
      if (yearMatch) {
        const year = yearMatch[1];
        const beforeYear = fullText.substring(0, yearMatch.index).trim();
        let surname = null;
        const refKeys = [];
        const commaInitialMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+(?:\s+(?:van|der|de|la|von))?[a-zA-Z'-]*),\s*[A-Z]/);
        if (commaInitialMatch) {
          surname = commaInitialMatch[1].trim();
          console.log(`\u{1F4DA} OUP: Pattern 1 (Surname, Initial) matched: "${surname}" from beforeYear: "${beforeYear}"`);
        } else {
          console.log(`\u{1F4DA} OUP: Pattern 1 failed to match beforeYear: "${beforeYear}"`);
        }
        if (!surname) {
          const simpleMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+)\s+([A-Z][a-zA-Z']+)/);
          if (simpleMatch) {
            surname = simpleMatch[1];
            console.log(`\u{1F4DA} OUP: Pattern 2 (Surname Firstname) matched: "${surname}"`);
          }
        }
        if (!surname) {
          const multiAuthorMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+)/);
          if (multiAuthorMatch) {
            surname = multiAuthorMatch[1];
            console.log(`\u{1F4DA} OUP: Pattern 3 (Multi-author) matched: "${surname}"`);
          }
        }
        if (surname) {
          refKeys.push(surname.toLowerCase() + year);
          if (surname.includes("-")) {
            refKeys.push(surname.toLowerCase().replace(/-/g, "") + year);
          }
          const referenceId = refKeys[0];
          references.push({
            content: fullText,
            originalText: fullText,
            type: "oup-bibliography",
            needsKeyGeneration: false,
            refKeys,
            referenceId,
            contentId
          });
          console.log(`\u{1F4DA} OUP: Extracted reference "${referenceId}" with keys: [${refKeys.join(", ")}]`);
        } else {
          references.push({
            content: fullText,
            originalText: fullText,
            type: "oup-bibliography-fallback",
            needsKeyGeneration: true,
            contentId
          });
          console.log(`\u{1F4DA} OUP: Extracted reference (fallback pattern, will generate keys): "${fullText.substring(0, 60)}..."`);
        }
      } else {
        console.warn(`\u26A0\uFE0F OUP: No year found in bibliography item: "${fullText.substring(0, 60)}..."`);
      }
    });
    const splitviewItems = dom.querySelectorAll(".js-splitview-ref-item");
    if (splitviewItems.length > 0) {
      console.log(`\u{1F4DA} OUP: Found ${splitviewItems.length} splitview reference items`);
      splitviewItems.forEach((item) => {
        const fullText = item.textContent.trim();
        if (fullText && fullText.length > 10 && !references.find((r) => r.content === fullText)) {
          references.push({
            content: fullText,
            originalText: fullText,
            type: "oup-splitview",
            needsKeyGeneration: true
          });
        }
      });
    }
    console.log(`\u{1F4DA} OUP: Total references extracted: ${references.length}`);
    return references;
  }
  /**
   * Remove duplicate OUP tables (modal vs inline versions)
   * OUP provides .table-modal (for popup) and .table-full-width-wrap (inline)
   * Keep inline version, remove modal
   *
   * @param {HTMLElement} dom - DOM element
   */
  handleDuplicateTables(dom) {
    const modalContainers = dom.querySelectorAll(".table-modal");
    modalContainers.forEach((modalContainer) => {
      modalContainer.remove();
      console.log("\u{1F4DA} OUP: Removed duplicate table modal");
    });
  }
  /**
   * Preserve table captions by extracting them from .table-wrap-title
   * Creates clean paragraph with "Table N. Caption text" format
   *
   * @param {HTMLElement} dom - DOM element
   */
  preserveTableCaptions(dom) {
    const tableWraps = dom.querySelectorAll(".table-wrap, .table-full-width-wrap");
    tableWraps.forEach((wrap) => {
      const titleContainer = wrap.querySelector(".table-wrap-title");
      const label = wrap.querySelector(".label, .title-label");
      const caption = wrap.querySelector(".caption");
      const table = wrap.querySelector("table");
      if (label && caption && table) {
        const labelText = label.textContent.trim();
        const captionPara = caption.querySelector("p");
        const captionText = (captionPara ? captionPara.textContent : caption.textContent).trim();
        const captionP = document.createElement("p");
        captionP.innerHTML = `<strong>${labelText}</strong> ${captionText}`;
        table.parentNode.insertBefore(captionP, table);
        if (titleContainer) {
          titleContainer.remove();
        }
        console.log(`\u{1F4DA} OUP: Preserved table caption: "${labelText} ${captionText.substring(0, 40)}..."`);
      }
    });
  }
  /**
   * Preserve figure captions by extracting them from .graphic-bottom
   * Creates clean paragraph with "Fig. N. Caption text" format
   *
   * @param {HTMLElement} dom - DOM element
   */
  preserveFigureCaptions(dom) {
    const graphicWraps = dom.querySelectorAll(".graphic-wrap");
    graphicWraps.forEach((wrap) => {
      const label = wrap.querySelector(".fig-label, .label");
      const caption = wrap.querySelector(".fig-caption, .caption");
      const img = wrap.querySelector("img");
      if (label && caption && img) {
        const labelText = label.textContent.trim();
        const captionText = caption.textContent.trim();
        const captionP = document.createElement("p");
        captionP.innerHTML = `<strong>${labelText}</strong> ${captionText}`;
        img.parentNode.insertBefore(captionP, img);
        const graphicBottom = wrap.querySelector(".graphic-bottom");
        if (graphicBottom) {
          graphicBottom.remove();
        }
        console.log(`\u{1F4DA} OUP: Preserved figure caption: "${labelText} ${captionText.substring(0, 40)}..."`);
      }
    });
  }
  /**
   * Remove original Footnotes and Bibliography sections from body
   * These sections are already extracted and will be appended as clean sections at the end
   * Prevents duplicate/mangled content in body
   *
   * @param {HTMLElement} dom - DOM element
   */
  removeExtractedSections(dom) {
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} OUP: Removed ${removedSections + removedStatic} extracted section(s) from body`);
  }
  /**
   * Transform structure - unwrap divs and clean up
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} OUP: Applying general structure transformation");
    this.handleDuplicateTables(dom);
    this.removeExtractedSections(dom);
    this.preserveTableCaptions(dom);
    this.preserveFigureCaptions(dom);
    const uiElements = dom.querySelectorAll(".js-view-large, .openInAnotherWindow, .download-slide, .table-open-button-wrap, .ajax-articleAbstract-exclude-regex, .figure-button-wrap");
    uiElements.forEach((el) => el.remove());
    console.log(`\u{1F4DA} OUP: Removed ${uiElements.length} UI elements (buttons, links)`);
    unwrapContainers(dom);
    const xrefLinks = dom.querySelectorAll("span.xrefLink");
    xrefLinks.forEach((span) => {
      if (!span.textContent.trim()) {
        span.remove();
      }
    });
    console.log(`\u{1F4DA} OUP: Removed ${xrefLinks.length} empty xrefLink spans`);
    console.log(`\u{1F4DA} OUP: Transformation complete`);
  }
  /**
   * Override linkCitations to convert OUP-specific citation links
   * OUP uses <a reveal-id="CIT..." data-open="CIT..."> for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    console.log("\u{1F4DA} OUP: Converting OUP-specific citation links...");
    const citationLinks = dom.querySelectorAll('a[reveal-id^="CIT"], a[data-open^="CIT"]');
    let convertedCount = 0;
    let failedCount = 0;
    citationLinks.forEach((link) => {
      const citId = link.getAttribute("reveal-id") || link.getAttribute("data-open");
      const citText = link.textContent.trim();
      let year, author, beforeYear, isNarrative = false, isSplitCitation = false;
      const incompleteBracketMatch = citText.match(/^(.+?)\s*\((\d{4}[a-z]?)$/);
      if (incompleteBracketMatch) {
        let nextNode = link.nextSibling;
        let foundNextCitation = false;
        while (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
          const text = nextNode.textContent.trim();
          if (text && !/^[,\s]+$/.test(text)) {
            break;
          }
          nextNode = nextNode.nextSibling;
        }
        if (nextNode && nextNode.nodeType === Node.ELEMENT_NODE) {
          const isNextCitation = nextNode.hasAttribute("reveal-id") || nextNode.hasAttribute("data-open") || nextNode.tagName === "A" && nextNode.classList.contains("in-text-citation");
          if (isNextCitation) {
            const nextText = nextNode.textContent.trim();
            if (/^\d{4}[a-z]?$/.test(nextText)) {
              foundNextCitation = true;
              isSplitCitation = true;
            }
          }
        }
        if (isSplitCitation) {
          author = incompleteBracketMatch[1].trim();
          year = incompleteBracketMatch[2];
          beforeYear = author + " (";
          console.log(`\u{1F4DA} OUP: Detected SPLIT CITATION: "${author} (${year}" followed by another year`);
        } else {
          author = incompleteBracketMatch[1].trim();
          year = incompleteBracketMatch[2];
          beforeYear = author + " ";
          isNarrative = true;
          console.log(`\u{1F4DA} OUP: Detected incomplete narrative citation: "${author} (${year}" (missing closing bracket)`);
        }
      } else {
        const narrativeMatch = citText.match(/^(.+?)\s*\((\d{4}[a-z]?)\)$/);
        if (narrativeMatch) {
          author = narrativeMatch[1].trim();
          year = narrativeMatch[2];
          beforeYear = author + " ";
          isNarrative = true;
          console.log(`\u{1F4DA} OUP: Detected complete narrative citation: "${author} (${year})"`);
        }
      }
      if (!author && !year) {
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
        if (!yearMatch) {
          console.warn(`\u26A0\uFE0F OUP: Could not extract year from citation: "${citText}"`);
          failedCount++;
          return;
        }
        year = yearMatch[1];
        beforeYear = citText.substring(0, yearMatch.index).trim();
        if (beforeYear) {
          author = beforeYear.replace(/[,\s()]+$/, "").trim();
        }
        if (!author && /^\d{4}[a-z]?$/.test(citText)) {
          console.log(`\u{1F4DA} OUP: Year-only citation "${citText}" - looking for previous citation to inherit author`);
          let prevNode = link.previousSibling;
          let foundPrevCitation = false;
          while (prevNode && !foundPrevCitation) {
            if (prevNode.nodeType === Node.TEXT_NODE) {
              const text = prevNode.textContent;
              if (text.trim() && !/^[,\s]+$/.test(text)) {
                console.log(`\u{1F4DA} OUP: Stopped search - hit non-citation text: "${text}"`);
                break;
              }
            } else if (prevNode.nodeType === Node.ELEMENT_NODE) {
              const isPrevOupCitation = prevNode.hasAttribute("reveal-id") || prevNode.hasAttribute("data-open") || prevNode.tagName === "A" && prevNode.classList.contains("in-text-citation");
              if (isPrevOupCitation) {
                const prevCitText = prevNode.textContent.trim();
                const prevYearMatch = prevCitText.match(/\b(\d{4}[a-z]?)\b/);
                if (prevYearMatch) {
                  let extractedAuthor = null;
                  if (prevNode.classList.contains("in-text-citation")) {
                    let authorNode = prevNode.previousSibling;
                    while (authorNode && authorNode.nodeType === Node.TEXT_NODE) {
                      const authorText = authorNode.textContent.trim();
                      if (authorText && !/^[,\s()]+$/.test(authorText)) {
                        extractedAuthor = authorText.replace(/[,\s()]+$/, "").trim();
                        break;
                      }
                      authorNode = authorNode.previousSibling;
                    }
                  } else {
                    const prevBeforeYear = prevCitText.substring(0, prevYearMatch.index).trim();
                    if (prevBeforeYear) {
                      extractedAuthor = prevBeforeYear.replace(/[,\s()]+$/, "").trim();
                    }
                  }
                  if (extractedAuthor) {
                    author = extractedAuthor;
                    foundPrevCitation = true;
                    console.log(`\u{1F4DA} OUP: Inherited author "${author}" from previous citation (converted: ${prevNode.classList.contains("in-text-citation")})`);
                  }
                }
                break;
              }
            }
            prevNode = prevNode.previousSibling;
          }
          if (!foundPrevCitation) {
            console.log(`\u{1F4DA} OUP: No previous citation found to inherit author from`);
          }
        }
      }
      const possibleKeys = [];
      if (author) {
        const firstAuthor = author.split(/\s+and\s+/i)[0].trim();
        let cleanAuthor = firstAuthor.replace(/\s+et\s+al\.?/gi, "").replace(/\s+eds?\.?$/gi, "").replace(/,\s*$/g, "").trim();
        const words = cleanAuthor.split(/\s+/);
        const surname = words[words.length - 1];
        possibleKeys.push(surname.toLowerCase() + year);
        if (surname.includes("-")) {
          possibleKeys.push(surname.toLowerCase().replace(/-/g, "") + year);
        }
        console.log(`\u{1F4DA} OUP: Citation "${citText}" \u2192 firstAuthor: "${firstAuthor}" \u2192 cleanAuthor: "${cleanAuthor}" \u2192 surname: "${surname}" \u2192 keys: [${possibleKeys.slice(0, 2).join(", ")}]`);
        possibleKeys.push(cleanAuthor.toLowerCase().replace(/\s+/g, "") + year);
      }
      possibleKeys.push(year.toLowerCase());
      let matchedReference = null;
      for (const reference of references) {
        if (reference.refKeys) {
          for (const key of possibleKeys) {
            if (reference.refKeys.includes(key)) {
              matchedReference = reference;
              break;
            }
          }
        }
        if (matchedReference) break;
      }
      if (matchedReference && matchedReference.referenceId) {
        link.setAttribute("href", `#${matchedReference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        const afterYearPos = citText.indexOf(year) + year.length;
        const trailing = isNarrative ? "" : citText.substring(afterYearPos);
        reformatCitationLink(link, {
          author: beforeYear || "",
          year,
          isNarrative,
          trailing
        });
        link.removeAttribute("reveal-id");
        link.removeAttribute("data-open");
        link.removeAttribute("data-google-interstitial");
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F OUP: Could not find reference for "${citText}" (${citId}), tried keys:`, possibleKeys);
        failedCount++;
      }
    });
    console.log(`  - Converted ${convertedCount} OUP citation links, ${failedCount} failed`);
  }
};

// resources/js/paste/format-processors/sage-processor.ts
var SageProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("sage");
  }
  /**
   * Extract footnotes from Sage structure
   * Sage typically uses <sup> tags for footnote markers
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = /* @__PURE__ */ new Map();
    console.log("\u{1F4DA} Sage: Looking for footnotes");
    const supElements = dom.querySelectorAll("sup");
    const refIdentifiers = /* @__PURE__ */ new Set();
    const refIdMapping = /* @__PURE__ */ new Map();
    supElements.forEach((sup) => {
      const identifier = sup.textContent.trim() || sup.getAttribute("fn-count-id");
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);
        const link = sup.querySelector('a[href*="#fn"]');
        if (link) {
          const href = link.getAttribute("href");
          const match = href.match(/#(fn\d+-[a-z0-9]+)/);
          if (match) {
            refIdMapping.set(identifier, match[1]);
            console.log(`\u{1F4DA} Sage: Mapped footnote ${identifier} to ID ${match[1]}`);
          }
        }
      }
    });
    console.log(`\u{1F4DA} Sage: Found ${refIdentifiers.size} footnote references in <sup> tags`);
    const potentialDefs = /* @__PURE__ */ new Map();
    for (const identifier of refIdentifiers) {
      let fnElement = null;
      if (refIdMapping.has(identifier)) {
        const fullId = refIdMapping.get(identifier);
        fnElement = dom.querySelector(`#${fullId}`);
        if (fnElement) {
          console.log(`\u{1F4DA} Sage: Found footnote ${identifier} by complex ID: ${fullId}`);
        }
      }
      if (!fnElement) {
        fnElement = dom.querySelector(`#fn${identifier}`);
        if (fnElement) {
          console.log(`\u{1F4DA} Sage: Found footnote ${identifier} by simple ID: fn${identifier}`);
        }
      }
      if (fnElement) {
        potentialDefs.set(identifier, fnElement);
      }
    }
    console.log(`\u{1F4DA} Sage: Found ${potentialDefs.size} footnotes by ID`);
    const listItems = dom.querySelectorAll('[role="listitem"]');
    listItems.forEach((item) => {
      const text = item.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1])) {
        potentialDefs.set(match[1], item);
        console.log(`\u{1F4DA} Sage: Found footnote ${match[1]} in listitem: "${text.substring(0, 50)}..."`);
      }
    });
    const refElements = dom.querySelectorAll(".ref");
    refElements.forEach((ref) => {
      const text = ref.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1]) && !potentialDefs.has(match[1])) {
        potentialDefs.set(match[1], ref);
        console.log(`\u{1F4DA} Sage: Found footnote ${match[1]} in .ref: "${text.substring(0, 50)}..."`);
      }
    });
    dom.querySelectorAll("p").forEach((p) => {
      const text = p.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1]) && !potentialDefs.has(match[1])) {
        potentialDefs.set(match[1], p);
        console.log(`\u{1F4DA} Sage: Found footnote ${match[1]} in paragraph: "${text.substring(0, 50)}..."`);
      }
    });
    for (const identifier of refIdentifiers) {
      const element = potentialDefs.get(identifier);
      if (element) {
        let htmlContent = element.innerHTML.trim();
        htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, "");
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          "sage"
        );
        footnotes.push(footnote);
        footnoteMappings.set(identifier, footnote);
        console.log(`\u{1F4DA} Sage: Extracted footnote ${identifier}: "${htmlContent.substring(0, 50)}..."`);
        element.remove();
      } else {
        console.warn(`\u26A0\uFE0F Sage: Could not find definition for footnote ${identifier}`);
      }
    }
    console.log(`\u{1F4DA} Sage: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Extract references from Sage bibliography
   * Sage uses elements with IDs matching citation data-xml-rid attributes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} Sage: Looking for references");
    const biblioElements = dom.querySelectorAll('[id^="bibr"]');
    if (biblioElements.length > 0) {
      console.log(`\u{1F4DA} Sage: Found ${biblioElements.length} bibliography elements with bibr IDs`);
      biblioElements.forEach((element) => {
        const xmlRid = element.id;
        const clone = cloneAndClean(element, [".external-links", ".core-xlink-google-scholar", ".to-citation__wrapper"]);
        let contentElement = clone.querySelector(".citation-content");
        if (!contentElement) {
          contentElement = clone;
        }
        const text = contentElement.textContent.trim();
        const htmlContent = contentElement.innerHTML.trim();
        if (isValidReference(text)) {
          references.push({
            content: htmlContent,
            originalText: text,
            type: "sage-biblio",
            needsKeyGeneration: true,
            xmlRid
            // Store for potential linking
          });
          console.log(`\u{1F4DA} Sage: Extracted reference ${xmlRid}: "${text.substring(0, 60)}..."`);
        }
      });
    }
    if (references.length === 0) {
      const citationContainers = dom.querySelectorAll(".citations");
      if (citationContainers.length > 0) {
        console.log(`\u{1F4DA} Sage: Fallback - Found ${citationContainers.length} .citations containers`);
        citationContainers.forEach((container) => {
          const items = container.querySelectorAll('li, p, [role="listitem"]');
          items.forEach((item) => {
            const clone = cloneAndClean(item, [".external-links", ".core-xlink-google-scholar", ".to-citation__wrapper"]);
            const text = clone.textContent.trim();
            const htmlContent = clone.innerHTML.trim();
            if (isValidReference(text)) {
              references.push({
                content: htmlContent,
                originalText: text,
                type: "sage-citation",
                needsKeyGeneration: true
              });
              console.log(`\u{1F4DA} Sage: Extracted reference from .citations: "${text.substring(0, 60)}..."`);
            }
          });
        });
      }
    }
    const refElements = dom.querySelectorAll(".ref");
    refElements.forEach((ref) => {
      const text = ref.textContent.trim();
      if (/^\d+[\.\)]/.test(text)) {
        return;
      }
      if (isValidReference(text)) {
        const clone = cloneAndClean(ref, [".external-links", ".core-xlink-google-scholar", ".to-citation__wrapper"]);
        const cleanText = clone.textContent.trim();
        const htmlContent = clone.innerHTML.trim();
        const newRef = {
          content: htmlContent,
          originalText: cleanText,
          type: "sage-ref",
          needsKeyGeneration: true
        };
        if (addUniqueReference(references, newRef)) {
          console.log(`\u{1F4DA} Sage: Extracted reference from .ref: "${cleanText.substring(0, 60)}..."`);
        }
      }
    });
    if (references.length === 0) {
      console.log("\u{1F4DA} Sage: No specific elements found, using general reference detection");
      const allElements = Array.from(dom.children);
      let referenceSectionStartIndex = -1;
      const refHeadings = /^(references|bibliography|notes|sources)$/i;
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
          referenceSectionStartIndex = i;
          break;
        }
      }
      if (referenceSectionStartIndex !== -1) {
        const elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter((el) => el.tagName === "P");
        elementsToScan.forEach((p) => {
          const clone = cloneAndClean(p, [".external-links", ".core-xlink-google-scholar", ".to-citation__wrapper"]);
          const text = clone.textContent.trim();
          const htmlContent = clone.innerHTML.trim();
          if (!text) return;
          if (isValidReference(text)) {
            references.push({
              content: htmlContent,
              originalText: text,
              type: "sage-paragraph",
              needsKeyGeneration: true
            });
          }
        });
      }
    }
    console.log(`\u{1F4DA} Sage: Total references extracted: ${references.length}`);
    return references;
  }
  /**
   * Transform structure - unwrap divs and clean up
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} Sage: Applying general structure transformation");
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} Sage: Removed ${removedSections + removedStatic} section(s) from main content`);
    unwrapContainers(dom);
    console.log(`\u{1F4DA} Sage: Transformation complete`);
  }
  /**
   * Override linkCitations to convert Sage-specific citation links
   * Sage uses <a role="doc-biblioref" data-xml-rid="bibr*"> for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    console.log("\u{1F4DA} Sage: Converting Sage-specific citation links...");
    const citationLinks = dom.querySelectorAll('a[role="doc-biblioref"], a[data-xml-rid^="bibr"]');
    let convertedCount = 0;
    let failedCount = 0;
    citationLinks.forEach((link) => {
      const citText = link.textContent.trim();
      const xmlRid = link.getAttribute("data-xml-rid");
      console.log(`\u{1F4DA} Sage: Processing citation link: "${citText}" (xml-rid: ${xmlRid})`);
      const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
      if (!yearMatch) {
        console.warn(`\u26A0\uFE0F Sage: Could not extract year from citation: "${citText}"`);
        failedCount++;
        return;
      }
      const year = yearMatch[1];
      const beforeYear = citText.substring(0, yearMatch.index).trim();
      const isNarrative = beforeYear.endsWith("(");
      const possibleKeys = [];
      if (beforeYear) {
        let cleanAuthor = beforeYear.replace(/\s+et\s+al\.?/gi, "").replace(/\s+and\s+/gi, " ").replace(/,\s*$/g, "").replace(/\(\s*$/g, "").trim();
        const authorParts = cleanAuthor.split(/\s*,\s*/);
        const firstAuthor = authorParts[0];
        const words = firstAuthor.split(/\s+/);
        const surname = words[words.length - 1];
        possibleKeys.push(surname.toLowerCase() + year);
        if (surname.includes("-")) {
          possibleKeys.push(surname.toLowerCase().replace(/-/g, "") + year);
        }
        if (authorParts.length > 1) {
          const surnames = authorParts.map((part) => {
            const w = part.trim().split(/\s+/);
            return w[w.length - 1].toLowerCase();
          });
          possibleKeys.push(surnames.join("") + year);
        }
        console.log(`\u{1F4DA} Sage: Generated keys for "${citText}": [${possibleKeys.join(", ")}]`);
      }
      possibleKeys.push(year.toLowerCase());
      let matchedReference = null;
      if (xmlRid) {
        matchedReference = references.find((ref) => ref.xmlRid === xmlRid);
        if (matchedReference) {
          console.log(`\u{1F4DA} Sage: Matched "${citText}" to reference via xmlRid "${xmlRid}"`);
        }
      }
      if (!matchedReference) {
        for (const reference of references) {
          if (reference.refKeys) {
            for (const key of possibleKeys) {
              if (reference.refKeys.includes(key)) {
                matchedReference = reference;
                console.log(`\u{1F4DA} Sage: Matched "${citText}" to reference via key "${key}"`);
                break;
              }
            }
          }
          if (matchedReference) break;
        }
      }
      if (matchedReference && matchedReference.referenceId) {
        link.setAttribute("href", `#${matchedReference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        let cleanAuthor = "";
        if (beforeYear) {
          if (isNarrative) {
            cleanAuthor = beforeYear.replace(/\(\s*$/, "").trim();
          } else {
            cleanAuthor = beforeYear.replace(/[,\s]+$/, "") + ", ";
          }
        }
        const afterYearPos = citText.indexOf(year) + year.length;
        const trailing = isNarrative ? "" : citText.substring(afterYearPos);
        reformatCitationLink(link, {
          author: cleanAuthor,
          year,
          isNarrative,
          trailing
        });
        link.removeAttribute("role");
        link.removeAttribute("data-xml-rid");
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Sage: Could not find reference for "${citText}" (${xmlRid}), tried keys:`, possibleKeys);
        failedCount++;
      }
    });
    console.log(`  - Converted ${convertedCount} Sage citation links, ${failedCount} failed`);
  }
  /**
   * Override linkFootnotes to handle Sage-specific linking
   * Similar to general processor - finds <sup> tags and links them
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`\u{1F4DA} Sage: Linking ${footnotes.length} footnotes to in-text references`);
    const supTags = dom.querySelectorAll("sup");
    let linkedCount = 0;
    supTags.forEach((sup) => {
      const identifier = sup.textContent.trim() || sup.getAttribute("fn-count-id");
      if (/^\d+$/.test(identifier)) {
        const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
        if (footnote) {
          const newSup = createFootnoteSupElement(footnote.refId, identifier);
          sup.replaceWith(newSup);
          linkedCount++;
        }
      }
    });
    console.log(`  - Linked ${linkedCount} Sage footnote references`);
  }
};

// resources/js/paste/format-processors/science-direct-processor.ts
var ScienceDirectProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("science-direct");
    this.bibIdToRefMap = /* @__PURE__ */ new Map();
  }
  /**
   * Extract footnotes from Science Direct structure
   * Science Direct typically doesn't use traditional footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    console.log("\u{1F4DA} ScienceDirect: Science Direct typically uses inline references, not footnotes");
    return [];
  }
  /**
   * Extract references from Science Direct bibliography
   * Science Direct uses <span class="reference"> elements with complex nested structure
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} ScienceDirect: Looking for references");
    const referenceSpans = dom.querySelectorAll("span.reference[id]");
    if (referenceSpans.length > 0) {
      console.log(`\u{1F4DA} ScienceDirect: Found ${referenceSpans.length} reference spans`);
      referenceSpans.forEach((refSpan) => {
        const refId = refSpan.id;
        const clone = cloneAndClean(refSpan, [".ReferenceLinks", "a.pdf", 'a[target="_blank"]', "svg"]);
        const htmlContent = this.flattenReferenceContent(clone);
        const text = clone.textContent.trim();
        const parentLi = refSpan.closest("li");
        let bibId = null;
        if (parentLi) {
          const labelAnchor = parentLi.querySelector("span.label a.anchor");
          if (labelAnchor) {
            const hrefMatch = labelAnchor.getAttribute("href");
            if (hrefMatch && hrefMatch.startsWith("#bb")) {
              bibId = hrefMatch.substring(2);
            }
          }
          if (!bibId) {
            const xocsAnchor = parentLi.querySelector('a[data-xocs-content-id^="b"]');
            if (xocsAnchor) {
              bibId = xocsAnchor.getAttribute("data-xocs-content-id");
            }
          }
        }
        if (!bibId) {
          const numMatch = refId.match(/\d+/);
          if (numMatch) {
            bibId = `b${numMatch[0]}`;
          }
        }
        if (text.length > 20) {
          const reference = {
            content: htmlContent,
            originalText: text,
            type: "science-direct",
            needsKeyGeneration: true,
            refId,
            // Store the actual reference ID (h0120, sref27, etc.)
            bibId
            // Store the citation link ID (b0120, etc.)
          };
          references.push(reference);
          if (bibId) {
            this.bibIdToRefMap.set(bibId, reference);
            if (bibId.startsWith("b") && !bibId.startsWith("bib")) {
              this.bibIdToRefMap.set("bi" + bibId, reference);
            }
          }
        }
      });
    }
    if (references.length === 0) {
      console.log("\u{1F4DA} ScienceDirect: No reference spans found, searching for reference list items");
      const headings = dom.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const heading of headings) {
        if (/references|bibliography/i.test(heading.textContent.trim())) {
          console.log(`\u{1F4DA} ScienceDirect: Found references section: "${heading.textContent.trim()}"`);
          let nextElement = heading.nextElementSibling;
          while (nextElement) {
            if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
              break;
            }
            let listsToProcess = [];
            if (nextElement.tagName === "UL" || nextElement.tagName === "OL") {
              listsToProcess.push(nextElement);
            } else if (nextElement.querySelectorAll) {
              const nestedLists = nextElement.querySelectorAll("ul, ol");
              listsToProcess.push(...nestedLists);
            }
            listsToProcess.forEach((list) => {
              const listItems = list.querySelectorAll("li");
              listItems.forEach((item, index) => {
                const clone = cloneAndClean(item, [".ReferenceLinks", "a.pdf", 'a[target="_blank"]', "svg"]);
                const text = clone.textContent.trim();
                const htmlContent = this.flattenReferenceContent(clone);
                if (isValidReference(text)) {
                  references.push({
                    content: htmlContent,
                    originalText: text,
                    type: "science-direct-list",
                    needsKeyGeneration: true
                  });
                  console.log(`\u{1F4DA} ScienceDirect: Extracted reference from list: "${text.substring(0, 60)}..."`);
                }
              });
            });
            nextElement = nextElement.nextElementSibling;
          }
        }
      }
    }
    console.log(`\u{1F4DA} ScienceDirect: Total references extracted: ${references.length}`);
    return references;
  }
  /**
   * Flatten nested block elements in reference content
   * Preserves inline elements (links, em, strong, sup, sub)
   * Converts everything to a single inline text flow suitable for <p> tag
   *
   * @param {HTMLElement} clone - Cloned reference element
   * @returns {string} - Flattened HTML content
   */
  flattenReferenceContent(clone) {
    const PRESERVE_INLINE = /* @__PURE__ */ new Set(["A", "EM", "I", "STRONG", "B", "SUP", "SUB"]);
    const BLOCK_ELEMENTS = /* @__PURE__ */ new Set(["DIV", "P", "SECTION", "ARTICLE", "LI", "HEADER"]);
    function flattenNode(node, addSpaceBefore = false) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (addSpaceBefore && text && !/^\s/.test(text)) {
          return " " + text;
        }
        return text;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();
        if (PRESERVE_INLINE.has(tagName)) {
          const tempEl = node.cloneNode(false);
          let childHtml = "";
          for (let child of node.childNodes) {
            childHtml += flattenNode(child, false);
          }
          tempEl.innerHTML = childHtml;
          return (addSpaceBefore ? " " : "") + tempEl.outerHTML;
        }
        if (BLOCK_ELEMENTS.has(tagName)) {
          let result2 = "";
          let isFirst = true;
          for (let child of node.childNodes) {
            const needsSpace = !isFirst && result2.trim().length > 0;
            result2 += flattenNode(child, needsSpace);
            isFirst = false;
          }
          if (addSpaceBefore && result2.trim().length > 0 && !/^\s/.test(result2)) {
            result2 = " " + result2;
          }
          return result2;
        }
        let result = "";
        for (let child of node.childNodes) {
          result += flattenNode(child, false);
        }
        return result;
      }
      return "";
    }
    const flattened = flattenNode(clone);
    return flattened.replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  }
  /**
   * Transform structure - remove bibliography sections and unwrap containers
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} ScienceDirect: Applying structure transformation");
    const headings = dom.querySelectorAll("h1, h2, h3, h4, h5, h6");
    headings.forEach((heading) => {
      const headingText = heading.textContent.trim().toLowerCase();
      if (/^(references|bibliography|works cited)$/i.test(headingText)) {
        let nextElement = heading.nextElementSibling;
        heading.remove();
        while (nextElement) {
          const next = nextElement.nextElementSibling;
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            break;
          }
          nextElement.remove();
          nextElement = next;
        }
      }
    });
    unwrapContainers(dom);
    this.convertCitationLinks(dom);
    console.log("\u{1F4DA} ScienceDirect: Transformation complete");
  }
  /**
   * Convert Science Direct citation links to proper reference links
   * MUST be called during transformStructure (before cleanup strips data attributes)
   *
   * Science Direct uses data-xocs-content-id="b*" for citations (not href)
   *
   * @param {HTMLElement} dom - DOM element
   */
  convertCitationLinks(dom) {
    console.log("\u{1F4DA} ScienceDirect: Converting Science Direct citation links...");
    const citationLinks = dom.querySelectorAll('a.anchor[data-xocs-content-type="reference"]');
    console.log(`\u{1F4DA} ScienceDirect: Found ${citationLinks.length} citation links`);
    let convertedCount = 0;
    let failedCount = 0;
    citationLinks.forEach((link) => {
      const bibId = link.getAttribute("data-xocs-content-id");
      const reference = this.bibIdToRefMap.get(bibId);
      if (reference) {
        const citText = link.textContent.trim();
        link.setAttribute("href", `#${bibId}`);
        link.setAttribute("class", "in-text-citation");
        link.setAttribute("data-temp-bibid", bibId);
        link.textContent = citText;
        link.removeAttribute("data-sd-ui-side-panel-opener");
        link.removeAttribute("data-xocs-content-type");
        link.removeAttribute("data-xocs-content-id");
        link.removeAttribute("name");
        convertedCount++;
      } else {
        const citText = link.textContent.trim();
        const textNode = document.createTextNode(citText);
        link.replaceWith(textNode);
        console.warn(`\u26A0\uFE0F ScienceDirect: Reference not found for ${bibId}, converted to plain text: "${citText}"`);
        failedCount++;
      }
    });
    console.log(`  - Converted ${convertedCount} Science Direct citation links, ${failedCount} failed`);
  }
  /**
   * Override linkCitations to update temporary bibId hrefs with actual reference IDs
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    const tempLinks = dom.querySelectorAll("a[data-temp-bibid]");
    console.log(`\u{1F4DA} ScienceDirect: Updating ${tempLinks.length} temporary citation links with reference IDs`);
    let updatedCount = 0;
    tempLinks.forEach((link) => {
      const bibId = link.getAttribute("data-temp-bibid");
      const reference = this.bibIdToRefMap.get(bibId);
      if (reference && reference.referenceId) {
        link.setAttribute("href", `#${reference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        link.removeAttribute("data-temp-bibid");
        updatedCount++;
      } else {
        console.warn(`\u26A0\uFE0F ScienceDirect: No reference ID found for bibId: ${bibId}`);
      }
    });
    console.log(`\u{1F4DA} ScienceDirect: Updated ${updatedCount} citation links with reference IDs`);
  }
};

// resources/js/paste/format-processors/springer-processor.ts
var SpringerProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("springer");
    this.refIdMap = /* @__PURE__ */ new Map();
  }
  /**
   * Extract footnotes from Springer structure
   * Springer uses <li id="Fn*"> for footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    console.log("\u{1F4DA} Springer: Looking for footnotes with Fn* IDs");
    const footnoteElements = dom.querySelectorAll('[id^="Fn"]');
    console.log(`\u{1F4DA} Springer: Found ${footnoteElements.length} footnote elements`);
    footnoteElements.forEach((element) => {
      const fnId = element.id;
      const identifierMatch = fnId.match(/Fn(\d+)/);
      if (!identifierMatch) {
        console.warn(`\u26A0\uFE0F Springer: Could not extract identifier from ID: ${fnId}`);
        return;
      }
      const identifier = identifierMatch[1];
      const contentClone = cloneAndClean(element, ['a[href*="#Fn"]', ".label"]);
      contentClone.querySelectorAll("sup").forEach((el) => {
        if (el.textContent.trim() === identifier) {
          el.remove();
        }
      });
      contentClone.removeAttribute("data-counter");
      let contentElement = contentClone.querySelector(".c-article-footnote--listed__content p, p");
      if (!contentElement) {
        contentElement = contentClone;
        console.warn(`\u26A0\uFE0F Springer: No content paragraph found for footnote ${identifier}, using entire element`);
      }
      const htmlContent = contentElement.innerHTML.trim();
      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          "springer"
        );
        footnotes.push(footnote);
        console.log(`\u{1F4DA} Springer: Extracted footnote ${identifier}: "${htmlContent.substring(0, 50)}..."`);
        element.remove();
      }
    });
    console.log(`\u{1F4DA} Springer: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Link footnotes to in-text references
   * Springer uses <sup><a href="#Fn*"> or full URLs with #Fn* anchors for footnote references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`\u{1F4DA} Springer: Linking ${footnotes.length} footnotes to in-text references`);
    const fnLinks = dom.querySelectorAll('a[href*="#Fn"]');
    let linkedCount = 0;
    fnLinks.forEach((link) => {
      const href = link.getAttribute("href");
      let identifierMatch;
      if (href.includes("#Fn")) {
        const anchor = href.substring(href.indexOf("#"));
        identifierMatch = anchor.match(/#Fn(\d+)/);
      }
      if (!identifierMatch) {
        console.warn(`\u26A0\uFE0F Springer: Could not extract identifier from href: ${href}`);
        return;
      }
      const identifier = identifierMatch[1];
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
      if (footnote) {
        const newSup = createFootnoteSupElement(footnote.refId, identifier);
        const parentSup = link.parentElement;
        if (parentSup && parentSup.tagName === "SUP") {
          parentSup.replaceWith(newSup);
        } else {
          link.replaceWith(newSup);
        }
        linkedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Springer: Could not find footnote for identifier ${identifier}`);
      }
    });
    console.log(`  - Linked ${linkedCount} Springer footnote references`);
  }
  /**
   * Extract references from Springer bibliography
   * Springer uses <p id="ref-CR*"> or <li id="ref-CR*"> for bibliography entries
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} Springer: Looking for bibliography items with ref-CR* IDs");
    const bibItems = dom.querySelectorAll('[id^="ref-CR"]');
    console.log(`\u{1F4DA} Springer: Found ${bibItems.length} bibliography items`);
    bibItems.forEach((item) => {
      const refId = item.id;
      const clone = cloneAndClean(item, [".c-article-references__links", 'a[target="_blank"]', "svg"]);
      let contentElement = clone.querySelector(".c-article-references__text, p");
      if (!contentElement) {
        contentElement = clone;
      }
      const htmlContent = contentElement.innerHTML.trim();
      const text = contentElement.textContent.trim();
      if (!text || text.length < 10) {
        console.warn(`\u26A0\uFE0F Springer: Skipping empty or too short bibliography item: ${refId}`);
        return;
      }
      const reference = {
        content: htmlContent,
        originalText: text,
        type: "springer-bibliography",
        needsKeyGeneration: true,
        refId
        // Store the reference ID (ref-CR75)
      };
      references.push(reference);
      this.refIdMap.set(refId, reference);
      console.log(`\u{1F4DA} Springer: Extracted reference ${refId}: "${text.substring(0, 60)}..."`);
      item.remove();
    });
    console.log(`\u{1F4DA} Springer: Total references extracted: ${references.length}`);
    return references;
  }
  /**
   * Transform structure - unwrap divs and clean up
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} Springer: Applying general structure transformation");
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} Springer: Removed ${removedSections + removedStatic} section(s) from main content`);
    unwrapContainers(dom, "ul, ol");
    console.log(`\u{1F4DA} Springer: Transformation complete`);
  }
  /**
   * Override linkCitations to convert Springer-specific citation links
   * Springer uses <a href="#ref-CR*"> or full URLs with #ref-CR* anchors for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    console.log("\u{1F4DA} Springer: Converting Springer-specific citation links...");
    const citationLinks = dom.querySelectorAll('a[href*="#ref-CR"]');
    let convertedCount = 0;
    let failedCount = 0;
    citationLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const citText = link.textContent.trim();
      let refId;
      if (href.includes("#")) {
        refId = href.substring(href.indexOf("#") + 1);
      } else {
        console.warn(`\u26A0\uFE0F Springer: href doesn't contain anchor: ${href}`);
        failedCount++;
        return;
      }
      const reference = this.refIdMap.get(refId);
      if (reference && reference.referenceId) {
        link.setAttribute("href", `#${reference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        const hasOpenParen = citText.includes("(");
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
        if (yearMatch) {
          const year = yearMatch[1];
          const isNarrative = hasOpenParen;
          let author = "";
          if (isNarrative) {
            author = citText.substring(0, citText.indexOf("(")).trim();
          } else {
            author = citText.substring(0, yearMatch.index).trim();
          }
          const afterYearPos = citText.indexOf(year) + year.length;
          const trailing = isNarrative ? "" : citText.substring(afterYearPos);
          reformatCitationLink(link, {
            author,
            year,
            isNarrative,
            trailing
          });
        } else {
          link.textContent = citText;
        }
        link.removeAttribute("data-track");
        link.removeAttribute("data-track-action");
        link.removeAttribute("data-track-label");
        link.removeAttribute("data-test");
        link.removeAttribute("aria-label");
        link.removeAttribute("title");
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Springer: Could not find reference for "${citText}" (${refId})`);
        failedCount++;
      }
    });
    console.log(`  - Converted ${convertedCount} Springer citation links, ${failedCount} failed`);
  }
};

// resources/js/paste/format-processors/substack-processor.ts
var SubstackProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("substack");
  }
  /**
   * Extract footnotes from Substack-specific structure
   * Substack uses:
   * - In-text: <a data-component-name="FootnoteAnchorToDOM" id="footnote-anchor-9-117335878" href="...">9</a>
   * - Content: <div class="footnote-content"><p>...</p></div>
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = /* @__PURE__ */ new Map();
    console.log("\u{1F4DA} Substack: Initial structure check:");
    console.log("  - FootnoteAnchorToDOM links:", dom.querySelectorAll('a[data-component-name="FootnoteAnchorToDOM"]').length);
    console.log("  - .footnote-content divs:", dom.querySelectorAll(".footnote-content").length);
    console.log("  - footnote-anchor links:", dom.querySelectorAll('[id^="footnote-anchor-"]').length);
    const footnoteAnchors = dom.querySelectorAll('a[data-component-name="FootnoteAnchorToDOM"]');
    console.log(`\u{1F4DA} Substack: Found ${footnoteAnchors.length} in-text footnote anchors`);
    footnoteAnchors.forEach((anchor) => {
      const identifier = anchor.textContent.trim();
      if (identifier && /^\d+$/.test(identifier)) {
        const cleanSup = createFootnoteSupElement("", identifier);
        cleanSup.removeAttribute("id");
        anchor.replaceWith(cleanSup);
      }
    });
    const footnoteContents = dom.querySelectorAll(".footnote-content");
    console.log(`\u{1F4DA} Substack: Found ${footnoteContents.length} footnote content containers`);
    footnoteContents.forEach((container) => {
      let footnoteNum = null;
      const backLink = container.querySelector('a[href*="#footnote-anchor-"]');
      if (backLink) {
        const href = backLink.getAttribute("href");
        const match = href.match(/#footnote-anchor-(\d+)(?:-\d+)?/);
        if (match) {
          footnoteNum = match[1];
        }
      }
      if (!footnoteNum) {
        let parent = container.parentElement;
        while (parent && !footnoteNum) {
          const parentId = parent.id;
          if (parentId) {
            const idMatch = parentId.match(/footnote-(\d+)(?:-\d+)?/);
            if (idMatch) {
              footnoteNum = idMatch[1];
            }
          }
          parent = parent.parentElement;
        }
      }
      if (!footnoteNum) {
        const anchorWithId = container.querySelector('a[href*="#footnote-anchor-"]') || container.parentElement?.querySelector('a[href*="#footnote-anchor-"]');
        if (anchorWithId) {
          const href = anchorWithId.getAttribute("href");
          const match = href.match(/#footnote-anchor-(\d+)(?:-\d+)?/);
          if (match) {
            footnoteNum = match[1];
          }
        }
      }
      if (!footnoteNum) {
        const firstText = container.textContent.trim();
        const numMatch = firstText.match(/^(\d+)/);
        if (numMatch) {
          footnoteNum = numMatch[1];
        }
      }
      if (!footnoteNum) {
        console.warn("\u{1F4DA} Substack: Could not determine footnote number for container");
        return;
      }
      const clone = container.cloneNode(true);
      clone.querySelectorAll('a[href*="#footnote-anchor-"]').forEach((el) => el.remove());
      let content = clone.innerHTML.trim();
      content = content.replace(/^(\s*<[^>]+>)*\s*\d+[\.\):\s]\s*/, "");
      const uniqueId = this.generateFootnoteId(bookId, footnoteNum);
      const uniqueRefId = this.generateFootnoteRefId(uniqueId);
      footnotes.push(this.createFootnote(
        uniqueId,
        content,
        footnoteNum,
        uniqueRefId,
        "substack"
      ));
      footnoteMappings.set(footnoteNum, { uniqueId, uniqueRefId });
      console.log(`\u{1F4DA} Substack: Extracted footnote ${footnoteNum}`);
    });
    footnoteContents.forEach((container) => {
      let parent = container.parentElement;
      container.remove();
      if (parent && (parent.textContent.trim() === "" || parent.classList.contains("footnote") || parent.id?.includes("footnote"))) {
        parent.remove();
      }
    });
    const footnoteWrappers = dom.querySelectorAll('[class*="footnote"], [id*="footnote"]');
    footnoteWrappers.forEach((el) => {
      if (!["A", "SUP", "SPAN"].includes(el.tagName)) {
        if (el.textContent.trim() === "" || el.querySelector(".footnote-content")) {
          el.remove();
        }
      }
    });
    console.log(`\u{1F4DA} Substack: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Extract references from content
   * Substack newsletters typically don't have formal bibliography sections
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Empty array (no references)
   */
  async extractReferences(dom, bookId) {
    console.log("\u{1F4DA} Substack: Skipping reference extraction (not applicable for newsletters)");
    return [];
  }
  /**
   * Transform document structure
   * Clean up Substack-specific HTML structures
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} Substack: Applying structure transformation");
    const removedSections = removeSectionsByHeading(dom, (text) => {
      const normalized = text.trim().toLowerCase();
      return ["footnotes", "notes", "endnotes"].includes(normalized);
    });
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} Substack: Removed ${removedSections + removedStatic} section(s)`);
    unwrapContainers(dom);
    dom.querySelectorAll("[data-component-name]").forEach((el) => {
      el.removeAttribute("data-component-name");
    });
    dom.querySelectorAll(".footnote-anchor").forEach((el) => {
      const href = el.getAttribute("href");
      if (href && href.includes("#footnote-anchor-")) {
        el.remove();
      }
    });
    console.log("\u{1F4DA} Substack: Transformation complete");
  }
  /**
   * Override linkFootnotes to handle Substack's simplified <sup> tags
   * Converts <sup fn-count-id="N">N</sup> to fully linked footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`\u{1F4DA} Substack: Linking ${footnotes.length} footnotes to in-text references`);
    const supTags = dom.querySelectorAll("sup[fn-count-id]");
    let linkedCount = 0;
    supTags.forEach((sup) => {
      const identifier = sup.getAttribute("fn-count-id");
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
      if (footnote) {
        const newSup = createFootnoteSupElement(footnote.refId, identifier);
        sup.replaceWith(newSup);
        linkedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Substack: Could not find footnote for identifier ${identifier}`);
      }
    });
    console.log(`  - Linked ${linkedCount} Substack footnote references`);
  }
};

// resources/js/paste/format-processors/wiley-processor.ts
var WileyProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("wiley");
    this.bibIdToRefMap = /* @__PURE__ */ new Map();
  }
  /**
   * Extract footnotes from Wiley structure
   * Wiley typically uses endnotes/references rather than traditional footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    console.log("\u{1F4DA} Wiley: Looking for footnotes");
    const noteElements = dom.querySelectorAll('.note, [role="doc-footnote"], .footnote');
    noteElements.forEach((element, index) => {
      const identifier = String(index + 1);
      const clone = cloneAndClean(element, [".back-link", 'a[href^="#"]']);
      const htmlContent = clone.innerHTML.trim();
      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          "wiley"
        );
        footnotes.push(footnote);
        element.remove();
      }
    });
    console.log(`\u{1F4DA} Wiley: Extraction complete - ${footnotes.length} footnotes extracted`);
    return footnotes;
  }
  /**
   * Extract references from Wiley bibliography
   * Wiley uses <li data-bib-id="..."> for bibliography entries
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    console.log("\u{1F4DA} Wiley: Looking for bibliography items with data-bib-id");
    const bibItems = dom.querySelectorAll("li[data-bib-id]");
    console.log(`\u{1F4DA} Wiley: Found ${bibItems.length} bibliography items`);
    bibItems.forEach((item) => {
      const bibId = item.getAttribute("data-bib-id");
      const clone = cloneAndClean(item, [
        ".extra-links",
        ".getFTR",
        ".getFTR__content",
        ".google-scholar",
        'a[target="_blank"]',
        '[aria-hidden="true"]',
        ".hidden"
      ]);
      const author = item.querySelector(".author")?.textContent?.trim() || "";
      const year = item.querySelector(".pubYear")?.textContent?.trim() || "";
      const htmlContent = clone.innerHTML.trim();
      const text = clone.textContent.trim();
      if (!text || text.length < 10) {
        console.warn(`\u26A0\uFE0F Wiley: Skipping empty or too short bibliography item: ${bibId}`);
        return;
      }
      let referenceId;
      if (author && year) {
        const refKeys = generateReferenceKeys(`${author} ${year}`, "", "wiley");
        referenceId = refKeys.length > 0 ? refKeys[0] : `wiley_${bibId}`;
      } else {
        referenceId = `wiley_${bibId}`;
      }
      const reference = {
        referenceId,
        content: htmlContent,
        originalText: text,
        type: "wiley-bibliography",
        needsKeyGeneration: true,
        // Let base class also generate keys for additional matching
        bibId
        // Store original bibId for citation linking
      };
      references.push(reference);
      this.bibIdToRefMap.set(bibId, reference);
      console.log(`\u{1F4DA} Wiley: Extracted reference ${bibId}: "${text.substring(0, 60)}..."`);
      item.remove();
    });
    console.log(`\u{1F4DA} Wiley: Total references extracted: ${references.length}`);
    return references;
  }
  /**
   * Transform structure - unwrap divs and clean up Wiley-specific elements
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log("\u{1F4DA} Wiley: Applying structure transformation");
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);
    const removedStatic = removeStaticContentElements(dom);
    console.log(`\u{1F4DA} Wiley: Removed ${removedSections + removedStatic} section(s) from main content`);
    const uiSelectors = [
      ".pb-dropzone",
      // Wiley dropzones
      ".loa-wrapper",
      // Author list wrappers
      ".accordion",
      // Accordions
      ".accordion-tabbed",
      // Tabbed accordions
      ".epub-sections",
      // Section metadata
      ".article-header__widget",
      // Header widgets
      ".article-tools",
      // Article tools
      ".metrics-section",
      // Metrics
      ".share-article",
      // Share buttons
      "[data-pb-dropzone]",
      // Data dropzones
      ".getFTR",
      // Full text resolver
      ".extra-links",
      // External links
      ".google-scholar",
      // Google Scholar links
      "svg",
      // SVG icons
      '[aria-hidden="true"]'
      // Hidden elements
    ];
    uiSelectors.forEach((selector) => {
      dom.querySelectorAll(selector).forEach((el) => el.remove());
    });
    dom.querySelectorAll("ul.article__references, ol.article__references").forEach((list) => {
      if (list.children.length === 0) {
        list.remove();
      }
    });
    unwrapContainers(dom);
    console.log(`\u{1F4DA} Wiley: Transformation complete`);
  }
  /**
   * Override linkCitations to convert Wiley-specific citation links
   * Wiley uses <a href="#bibId" class="bibLink"> or full URLs with #bibId anchors
   * Note: By the time this runs, cleanup has stripped classes, so we match by href pattern
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    console.log("\u{1F4DA} Wiley: Converting Wiley-specific citation links...");
    const allLinks = dom.querySelectorAll('a[href*="-bib-"]');
    let convertedCount = 0;
    let failedCount = 0;
    allLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const citText = link.textContent.trim();
      if (!href) {
        return;
      }
      let bibId;
      if (href.includes("#")) {
        bibId = href.substring(href.indexOf("#") + 1);
      } else {
        return;
      }
      if (!bibId.includes("-bib-")) {
        return;
      }
      const reference = this.bibIdToRefMap.get(bibId);
      if (reference && reference.referenceId) {
        link.setAttribute("href", `#${reference.referenceId}`);
        link.setAttribute("class", "in-text-citation");
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
        if (yearMatch) {
          const year = yearMatch[1];
          const yearIndex = citText.indexOf(year);
          let author = citText.substring(0, yearIndex).trim();
          author = author.replace(/[,;]$/, "").trim();
          author = author.replace(/^\(/, "").replace(/\)$/, "").trim();
          const isNarrative = author.length > 0 && !citText.startsWith("(");
          const afterYearPos = yearIndex + year.length;
          const trailing = citText.substring(afterYearPos).replace(/^\)/, "").trim();
          reformatCitationLink(link, {
            author,
            year,
            isNarrative,
            trailing
          });
        } else {
          link.textContent = citText;
        }
        link.removeAttribute("data-tab");
        link.removeAttribute("id");
        link.removeAttribute("data-tooltip");
        link.removeAttribute("tabindex");
        convertedCount++;
      } else {
        console.warn(`\u26A0\uFE0F Wiley: Could not find reference for "${citText}" (${bibId})`);
        failedCount++;
      }
    });
    console.log(`  - Converted ${convertedCount} Wiley citation links, ${failedCount} failed`);
  }
};

// resources/js/paste/format-processors/mit-press-processor.ts
var MitPressProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("mit-press");
  }
  /**
   * Footnote definitions: <div class="fn" content-id="fn1" id="fn1">.
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const els = dom.querySelectorAll('.fn[content-id^="fn"], div[content-id^="fn"]');
    els.forEach((element) => {
      const contentId = element.getAttribute("content-id");
      if (element.closest(".table-wrap-foot, .table-wrap, table, .fig, figure")) return;
      const m = contentId.match(/fn-?(\d+)/);
      if (!m) return;
      const identifier = parseInt(m[1], 10).toString();
      const clone = element.cloneNode(true);
      clone.querySelectorAll('.label, .fn-label, .end-note-link, a[href*="#fn"]').forEach((el) => el.remove());
      clone.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
      const html = clone.innerHTML.trim();
      if (!html) return;
      const footnote = this.createFootnote(
        this.generateFootnoteId(bookId, identifier),
        html,
        identifier,
        this.generateFootnoteRefId(this.generateFootnoteId(bookId, identifier)),
        "mit-press"
      );
      footnote.contentId = contentId;
      footnotes.push(footnote);
      element.remove();
    });
    return footnotes;
  }
  /**
   * In-text footnote refs: <a reveal-id="fn1" data-open="fn1" class="xref-fn">.
   * Identical to OUP — map to clean <sup fn-count-id>.
   */
  linkFootnotes(dom, footnotes) {
    const links = dom.querySelectorAll('a[reveal-id^="fn"], a[data-open^="fn"]');
    links.forEach((link) => {
      const revealId = link.getAttribute("reveal-id") || link.getAttribute("data-open");
      const m = revealId.match(/fn-?(\d+)/);
      if (!m) return;
      const identifier = parseInt(m[1], 10).toString();
      const footnote = footnotes.find((fn) => fn.originalIdentifier === identifier);
      if (!footnote) return;
      const newSup = createFootnoteSupElement(footnote.refId, identifier);
      const parentSup = link.parentElement;
      if (parentSup && parentSup.tagName === "SUP") {
        parentSup.replaceWith(newSup);
      } else {
        link.replaceWith(newSup);
      }
    });
  }
  /**
   * Reference definitions: [data-content-id^="bib"], text in .citation.
   * referenceId = the bib id itself (e.g. "bib1") so in-text
   * data-modal-source-id="bib1" links exactly.
   */
  async extractReferences(dom, bookId) {
    const references = [];
    const items = dom.querySelectorAll('[data-content-id^="bib"]');
    items.forEach((item) => {
      const bibId = item.getAttribute("data-content-id");
      const citation = item.querySelector(".citation, .mixed-citation") || item;
      const text = citation.textContent.replace(/\s+/g, " ").trim();
      if (!text || text.length < 10) return;
      references.push({
        content: text,
        originalText: text,
        type: "mit-press-bibliography",
        needsKeyGeneration: false,
        referenceId: bibId,
        refKeys: [bibId],
        contentId: bibId
      });
    });
    return references;
  }
  /**
   * In-text citations: <a data-modal-source-id="bibN" class="xref-bibr">.
   * Direct, exact mapping — set href + class, keep the visible text.
   */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    const refIds = new Set(references.map((r) => r.referenceId));
    const links = dom.querySelectorAll('a[data-modal-source-id^="bib"]');
    let linked = 0;
    links.forEach((link) => {
      const bibId = link.getAttribute("data-modal-source-id");
      if (!refIds.has(bibId)) return;
      link.setAttribute("href", `#${bibId}`);
      link.setAttribute("class", "in-text-citation");
      ["data-modal-source-id", "reveal-id", "data-open", "data-google-interstitial"].forEach((a) => link.removeAttribute(a));
      link.removeAttribute("style");
      linked++;
    });
    console.log(`\u{1F4DA} MIT Press: linked ${linked} in-text citations`);
  }
  /**
   * Strip MIT chrome + remove the original reference/footnote sections (they're
   * re-appended cleanly), then general unwrapping.
   */
  async transformStructure(dom, bookId) {
    removeSectionsByHeading(dom, isReferenceSectionHeading);
    removeStaticContentElements(dom);
    dom.querySelectorAll(
      ".stats-get-citation, .toolbar, .citation-tools, .article-tools, .js-view-large, .download-slide, .table-modal"
    ).forEach((el) => el.remove());
    unwrapContainers(dom);
  }
};

// resources/js/paste/format-detection/format-registry.ts
var FORMAT_REGISTRY = {
  // NOTE: Formats are checked in priority order (highest first)
  // More specific formats should have higher priority
  // Science Direct - Priority 5
  "science-direct": {
    selectors: [
      '[data-xocs-content-id^="b"]',
      ".anchor.anchor-primary[data-sd-ui-side-panel-opener]",
      "span.reference[id]"
    ],
    processor: ScienceDirectProcessor,
    priority: 5,
    description: "Science Direct content with XOCS data attributes"
  },
  // MIT Press (direct.mit.edu, Silverchair) - Priority 5
  // Distinguished from OUP by data-content-id / data-modal-source-id (OUP uses
  // bare content-id), so it must be checked before OUP.
  "mit-press": {
    selectors: [
      'a[data-modal-source-id^="bib"]',
      '[data-content-id^="bib"]',
      '.fn[content-id^="fn"]'
    ],
    processor: MitPressProcessor,
    priority: 5,
    description: "MIT Press (direct.mit.edu) Silverchair content with data-content-id attributes"
  },
  // OUP (Oxford University Press) - Priority 4
  "oup": {
    selectors: [
      '[content-id^="bib"]',
      ".js-splitview-ref-item",
      '.footnote[content-id^="fn"]'
    ],
    processor: OupProcessor,
    priority: 4,
    description: "Oxford University Press content with content-id attributes"
  },
  // Springer - Priority 4
  "springer": {
    selectors: [
      '[id^="ref-CR"]',
      'a[href*="#ref-CR"]',
      '[id^="Fn"]',
      'a[href*="#Fn"]',
      'a[data-track="click"][data-track-label="link"][href*="springer.com"]'
    ],
    processor: SpringerProcessor,
    priority: 4,
    description: "Springer Nature content with ref-CR and Fn ID patterns"
  },
  // Substack - Priority 4
  "substack": {
    selectors: [
      'a[data-component-name="FootnoteAnchorToDOM"]',
      ".footnote-content",
      'a[href*="substack.com"][href*="#footnote-"]',
      '[id^="footnote-anchor-"]'
    ],
    processor: SubstackProcessor,
    priority: 4,
    description: "Substack newsletter content with FootnoteAnchorToDOM components"
  },
  // Wiley Online Library - Priority 4
  "wiley": {
    selectors: [
      "a.bibLink",
      // Primary: citation links with bibLink class
      "[data-bib-id]",
      // Reference list items with data-bib-id
      'a.tab-link[href^="#"][data-tab="pane-pcw-references"]',
      // Citation links pointing to references pane
      'a[href*="onlinelibrary.wiley"]'
      // Fallback: Wiley domain links
    ],
    processor: WileyProcessor,
    priority: 4,
    description: "Wiley Online Library journals with bibId-based citations"
  },
  // Cambridge - Priority 3
  "cambridge": {
    selectors: [
      ".xref.fn",
      ".circle-list__item__grouped__content",
      '[id^="reference-"][id$="-content"]'
    ],
    processor: CambridgeProcessor,
    priority: 3,
    description: "Cambridge University Press content with xref.fn links"
  },
  // Taylor & Francis - Priority 4
  "taylor-francis": {
    selectors: [
      ".ref-lnk.lazy-ref.bibr",
      ".NLM_sec",
      ".hlFld-Abstract",
      'li[id^="CIT"]',
      'a[href*="tandfonline.com"]'
      // Catch T&F by domain
    ],
    processor: TaylorFrancisProcessor,
    priority: 4,
    description: "Taylor & Francis content with CIT IDs"
  },
  // Sage - Priority 3
  "sage": {
    selectors: [
      'a[href*="sagepub.com"]',
      // SAGE domain links (most reliable)
      'a[role="doc-noteref"]',
      // SAGE footnote links
      ".citations",
      ".ref",
      '[role="listitem"]'
    ],
    processor: SageProcessor,
    priority: 3,
    description: "Sage Publications content"
  },
  // General - Priority 0 (fallback, always matches)
  "general": {
    selectors: [],
    // Empty = matches anything (fallback)
    processor: GeneralProcessor,
    priority: 0,
    description: "General format (fallback for unrecognized formats)"
  }
};
function getFormatsByPriority() {
  return Object.entries(FORMAT_REGISTRY).sort(([, a], [, b]) => b.priority - a.priority);
}
function getFormatConfig(formatType) {
  return FORMAT_REGISTRY[formatType] || null;
}

// resources/js/paste/format-detection/format-detector.ts
function detectFormat(htmlContent) {
  if (!htmlContent || typeof htmlContent !== "string") {
    console.log("\u{1F4DA} No HTML content provided, using general format");
    return "general";
  }
  const tempDiv = createTempDOM(htmlContent);
  const formats = getFormatsByPriority();
  console.log("\u{1F50D} Detecting format from pasted content...");
  let domainOnlyFallback = null;
  for (const [formatType, config] of formats) {
    if (config.selectors.length === 0) {
      if (domainOnlyFallback) {
        const { formatType: fbType, matchedSelectors: fbSels, totalMatches: fbTotal, config: fbConfig } = domainOnlyFallback;
        console.log(`\u{1F4DA} Detected ${fbType} format (domain-only fallback):`);
        console.log(`  - Matched ${fbSels.length}/${fbConfig.selectors.length} selector patterns`);
        console.log(`  - Total elements: ${fbTotal}`);
        console.log(`  - Priority: ${fbConfig.priority}`);
        console.log(`  - Description: ${fbConfig.description}`);
        fbSels.forEach((sel) => {
          const count = tempDiv.querySelectorAll(sel).length;
          console.log(`    \u2713 ${sel} (${count} matches)`);
        });
        return fbType;
      }
      console.log(`\u{1F4DA} Using fallback format: ${formatType}`);
      return formatType;
    }
    const matchedSelectors = [];
    let totalMatches = 0;
    for (const selector of config.selectors) {
      try {
        const elements = tempDiv.querySelectorAll(selector);
        if (elements.length > 0) {
          matchedSelectors.push(selector);
          totalMatches += elements.length;
        }
      } catch (error) {
        console.warn(`Invalid selector "${selector}" for format "${formatType}":`, error);
      }
    }
    if (matchedSelectors.length > 0) {
      const allDomainOnly = matchedSelectors.every((sel) => /^a\[href\*=/.test(sel));
      if (allDomainOnly && !domainOnlyFallback) {
        console.log(`  \u23F3 ${formatType}: domain-only match, saving as fallback`);
        domainOnlyFallback = { formatType, matchedSelectors, totalMatches, config };
        continue;
      }
      console.log(`\u{1F4DA} Detected ${formatType} format:`);
      console.log(`  - Matched ${matchedSelectors.length}/${config.selectors.length} selector patterns`);
      console.log(`  - Total elements: ${totalMatches}`);
      console.log(`  - Priority: ${config.priority}`);
      console.log(`  - Description: ${config.description}`);
      matchedSelectors.forEach((sel) => {
        const count = tempDiv.querySelectorAll(sel).length;
        console.log(`    \u2713 ${sel} (${count} matches)`);
      });
      return formatType;
    }
  }
  console.warn("\u26A0\uFE0F No format matched, falling back to general");
  return "general";
}
function getProcessorForContent(htmlContent) {
  const formatType = detectFormat(htmlContent);
  const config = getFormatConfig(formatType);
  if (!config) {
    throw new Error(`No configuration found for format: ${formatType}`);
  }
  const ProcessorClass = config.processor;
  const processor = new ProcessorClass();
  return {
    formatType,
    processor
  };
}
function detectFormatVerbose(htmlContent) {
  const tempDiv = createTempDOM(htmlContent);
  const formats = getFormatsByPriority();
  const results = [];
  for (const [formatType, config] of formats) {
    if (config.selectors.length === 0) {
      results.push({
        formatType,
        matched: true,
        matchCount: 0,
        priority: config.priority,
        description: config.description,
        matchedSelectors: []
      });
      continue;
    }
    const matchedSelectors = [];
    let totalMatches = 0;
    for (const selector of config.selectors) {
      try {
        const elements = tempDiv.querySelectorAll(selector);
        if (elements.length > 0) {
          matchedSelectors.push({
            selector,
            count: elements.length
          });
          totalMatches += elements.length;
        }
      } catch (error) {
      }
    }
    results.push({
      formatType,
      matched: matchedSelectors.length > 0,
      matchCount: totalMatches,
      priority: config.priority,
      description: config.description,
      matchedSelectors
    });
  }
  results.sort((a, b) => b.priority - a.priority);
  const detectedFormat = results.find((r) => r.matched);
  return {
    detectedFormat: detectedFormat?.formatType || "general",
    allResults: results
  };
}
export {
  detectFormat,
  detectFormatVerbose,
  getProcessorForContent
};
