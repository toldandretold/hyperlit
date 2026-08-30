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
function processFootnoteReferences(htmlContent, footnoteMappings, formatType = "general", options = {}) {
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
    const skipPlainTextPattern = options.skipPlainTextScan === true || ["cambridge", "oup", "taylor-francis", "sage"].includes(formatType);
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

// resources/js/paste/utils/inline-fragment.ts
function flattenForInlineHost(html, doc = document) {
  if (!html) return html ?? "";
  if (!/<[a-z]/i.test(html)) return html;
  const temp = doc.createElement("div");
  temp.innerHTML = html;
  let guard = 0;
  for (; ; ) {
    const sole = temp.childNodes.length === 1 ? temp.children[0] : void 0;
    if (guard >= 5 || !sole || !isBlockElement(sole.tagName)) break;
    temp.innerHTML = sole.innerHTML;
    guard += 1;
  }
  Array.from(temp.children).forEach((child) => {
    if (!isBlockElement(child.tagName)) return;
    if (child.previousSibling && child.parentNode) {
      child.parentNode.insertBefore(doc.createElement("br"), child);
    }
    unwrap(child);
  });
  return temp.innerHTML;
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
  "fn-count-id"
  // Footnote click handler identifier
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
  "canvas"
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
      const linkedHtml = processFootnoteReferences(dom.innerHTML, footnoteMappings, this.formatType, {
        // Set by a processor whose markers were already resolved structurally —
        // the prose scanner would only invent extra ones from sentence-final digits.
        skipPlainTextScan: this.skipPlainTextFootnoteScan === true
      });
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
        const content = flattenForInlineHost(footnote.content);
        const contentStartsWithNumberDot = visuallyStartsWith(
          content,
          `${footnote.originalIdentifier}.`
        );
        const contentStartsWithNumberSpace = visuallyStartsWith(
          content,
          `${footnote.originalIdentifier} `
        );
        const contentStartsWithNumberParen = visuallyStartsWith(
          content,
          `${footnote.originalIdentifier})`
        );
        if (contentStartsWithNumberDot || contentStartsWithNumberSpace || contentStartsWithNumberParen) {
          p.innerHTML = content;
        } else {
          p.innerHTML = `${footnote.originalIdentifier}. ${content}`;
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
        p.innerHTML = flattenForInlineHost(reference.content);
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

// resources/js/paste/utils/reference-headings.ts
var REFERENCE_HEADINGS = [
  // English — reference lists
  "references",
  "reference",
  "reference list",
  "references cited",
  "cited references",
  "list of references",
  "citations",
  // English — bibliographies
  "bibliography",
  "bibliographies",
  "selected bibliography",
  "works cited",
  "works consulted",
  "cited works",
  "literature cited",
  // English — sources
  "sources",
  "primary sources",
  "secondary sources",
  // Compound forms (safe: the qualifier disambiguates them from a notes section)
  "notes and references",
  "references and notes",
  "references and further reading",
  "references and recommended reading",
  "further reading",
  "suggested reading",
  // Non-English
  "literatur",
  "literaturverzeichnis",
  "bibliographie",
  "r\xE9f\xE9rences",
  "referenties",
  "bibliograf\xEDa",
  "bibliografia",
  "referencias",
  "refer\xEAncias"
];
var HEADING_SET = new Set(REFERENCE_HEADINGS);
var LEADING_PREFIX_RE = /^(?:(?:appendix|annex|chapter|section|part)\s+[a-z0-9]{1,4}\s*[:.–—-]?\s*|[0-9]{1,2}(?:\.[0-9]{1,2})*(?:\s*[.):–—-]\s*|\s+)|[ivxlc]{1,5}\s*[.):]\s*)/;
function isReferenceHeading(headingText) {
  if (!headingText) return false;
  let normalized = headingText.trim().toLowerCase().replace(/\s+/g, " ").replace(/[‘’]/g, "'");
  normalized = normalized.replace(/[:.\s]+$/, "");
  normalized = normalized.replace(LEADING_PREFIX_RE, "").trim();
  return HEADING_SET.has(normalized);
}

// resources/js/paste/utils/reference-detection.ts
var MIN_RUN_LENGTH = 3;
var MAX_SANDWICH_GAP = 3;
var MAX_MISS_LENGTH = 500;
var MIN_ORDINALS_FOR_DENSITY = 3;
var MIN_ORDINAL_DENSITY = 0.5;
function ordinalDensity(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const span = (sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0) + 1;
  if (span <= 0) return 0;
  return new Set(sorted).size / span;
}
var ARTICLE_CHROME_RE = new RegExp(
  "^\\s*(?:article\\s+copyright\\b|copyright\\s*[:\xA9]|\xA9\\s*\\d{4}|orcid(?:\\s+id)?\\s*[:.]|(?:how\\s+)?to\\s+cite\\s+this\\s+(?:article|paper|work)\\b|cite\\s+this\\s+(?:article|paper|work)\\s+as\\b|published\\s+by\\s+.{0,80}?\\bon\\s+\\d{1,2}\\s+\\w+\\s+\\d{4}\\s*$|(?:submitted|received|revised|accepted)\\s+on\\s+\\d{1,2}\\s+\\w+\\s+\\d{4}\\b|competing\\s+interests?\\s*[:.]|conflicts?\\s+of\\s+interest\\s*[:.]|correspondence\\s*[:.]|e-?mail\\s*[:.]|received\\s*[:.].{0,60}accepted\\s*[:.]|this\\s+is\\s+an\\s+open[- ]access\\s+article\\b)",
  "i"
);
function isArticleChrome(text) {
  return ARTICLE_CHROME_RE.test(text || "");
}
var CITE_LABEL_RE = /^\s*(?:how\s+)?to\s+cite\s+this\s+(?:article|paper|work)\b/i;
function followsCiteLabel(el) {
  let previous = el?.previousElementSibling ?? null;
  let hops = 0;
  while (previous && hops < 2) {
    if (previous.tagName === "P") {
      return CITE_LABEL_RE.test(normalizeText(previous.textContent));
    }
    previous = previous.previousElementSibling;
    hops += 1;
  }
  return false;
}
var ORDINAL_PREFIX_RE = /^\s*\d{1,4}[.)]\s+/;
var REF_STRUCTURE_RE = /^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+,\s+(?:[A-ZÀ-ÖØ-Þ]\.|[A-ZÀ-ÖØ-Þ][a-zà-ÿß])|^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+.{0,40}?\(\d{4}[a-z]?\)/;
var REF_STRUCTURE_START_RE = /^\s*(?:\[\d+\]|\[\d{4}\]|[—–‒―⸺⸻-]{1,3}[.,\s]|(?:von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ])/i;
var VANCOUVER_RE = /^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+\s+[A-Z]{1,3}[,:]/;
var MISS_AUTHOR_SHAPE_RE = /^\s*[A-ZÀ-ÖØ-Þ][\w'’-]+\s+[A-Z]{1,3}\b[,.]?\s/;
function hasReferenceStructure(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (isArticleChrome(trimmed)) return false;
  if (matchesStructure(trimmed)) return true;
  const withoutOrdinal = trimmed.replace(ORDINAL_PREFIX_RE, "");
  return withoutOrdinal !== trimmed && matchesStructure(withoutOrdinal);
}
function matchesStructure(text) {
  if (REF_STRUCTURE_RE.test(text)) return true;
  if (REF_STRUCTURE_START_RE.test(text)) return true;
  return VANCOUVER_RE.test(text) && text.slice(0, 120).includes(":");
}
function isReferenceShaped(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (!/\d{4}/.test(trimmed)) return false;
  if (isArticleChrome(trimmed)) return false;
  if (/^\s*\[\d+\]/.test(trimmed)) return true;
  const withoutOrdinal = trimmed.replace(ORDINAL_PREFIX_RE, "");
  if (withoutOrdinal !== trimmed) {
    if (/^[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+,\s/.test(withoutOrdinal)) return true;
    if (/^[A-ZÀ-ÖØ-Þ][\s\S]{0,60}?\(\d{4}[a-z]?\)/.test(withoutOrdinal)) return true;
    if (VANCOUVER_RE.test(withoutOrdinal) && withoutOrdinal.slice(0, 120).includes(":")) return true;
    if (/^[a-zà-ÿ][\w'’-]*(?:\s+[\w'’-]+){0,3}[.,]\s+\(?(?:19|20)\d{2}[a-z]?\)?[.,]/.test(withoutOrdinal)) {
      return true;
    }
  }
  if (/^\s*\[\d{4}\]/.test(trimmed)) return true;
  if (/^\s*(?:von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ]/i.test(trimmed)) {
    return true;
  }
  if (/^\s*[—–‒―⸺⸻-]{1,3}[.,\s]/.test(trimmed)) return true;
  const firstChar = trimmed.charAt(0);
  return firstChar !== firstChar.toLowerCase() && firstChar === firstChar.toUpperCase();
}
function hasEarlyYear(text, window = 80) {
  return /\d{4}/.test(normalizeText(text).slice(0, window));
}
function collectReferenceRun(blocks, options = {}) {
  const {
    headingAnchored = false,
    minRunLength = MIN_RUN_LENGTH,
    maxSandwichGap = MAX_SANDWICH_GAP
  } = options;
  const isMember = headingAnchored ? isReferenceShaped : hasReferenceStructure;
  const accepted = [];
  let pending = [];
  const isTolerableMiss = (el, text) => pending.length < maxSandwichGap && text.length > 0 && text.length < MAX_MISS_LENGTH && !isArticleChrome(text) && !followsCiteLabel(el) && (MISS_AUTHOR_SHAPE_RE.test(text) || hasReferenceStructure(text));
  if (headingAnchored) {
    for (const el of blocks) {
      const text = normalizeText(el.textContent);
      if (!text) continue;
      if (isMember(text) && !followsCiteLabel(el)) {
        accepted.push(...pending);
        pending = [];
        accepted.push(el);
      } else if (isTolerableMiss(el, text)) {
        pending.push(el);
      } else {
        pending = [];
      }
    }
  } else {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const el = blocks[i];
      if (!el) continue;
      const text = normalizeText(el.textContent);
      if (!text) continue;
      if (isMember(text) && !followsCiteLabel(el)) {
        accepted.unshift(...pending);
        pending = [];
        accepted.unshift(el);
      } else if (accepted.length > 0 && isTolerableMiss(el, text)) {
        pending.unshift(el);
      } else {
        break;
      }
    }
    if (accepted.length < minRunLength) return [];
  }
  return applyOrdinalDensityGate(accepted);
}
function applyOrdinalDensityGate(accepted) {
  const ordinals = [];
  for (const el of accepted) {
    const match = normalizeText(el.textContent).match(/^\s*(\d{1,4})[.)]\s/);
    if (match?.[1]) ordinals.push({ el, n: parseInt(match[1], 10) });
  }
  if (ordinals.length < MIN_ORDINALS_FOR_DENSITY) return [...accepted];
  if (ordinalDensity(ordinals.map((o) => o.n)) >= MIN_ORDINAL_DENSITY) return [...accepted];
  const dropped = new Set(ordinals.map((o) => o.el));
  return accepted.filter((el) => !dropped.has(el));
}
function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// resources/js/paste/utils/anchor-footnotes.ts
var MIN_COHORT = 3;
var MAX_ID_HOPS = 3;
var MIN_DIRECTION_AGREEMENT = 0.9;
var MIN_DEFINITION_TEXT = 20;
var MIN_DEFINITION_TEXT_SHARE = 0.8;
var MAX_MARKER_TEXT = 12;
var SUPERSCRIPT_DIGITS = {
  "\u2070": "0",
  "\xB9": "1",
  "\xB2": "2",
  "\xB3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9"
};
function parseMarkerNumber(text) {
  if (!text) return null;
  let value = "";
  for (const char of text) {
    value += SUPERSCRIPT_DIGITS[char] ?? char;
  }
  value = value.replace(/[\s ]/g, "").replace(/^[[({【]+/, "").replace(/[\])}】]+$/, "").replace(/^[*†‡§¶]+/, "").replace(/[*†‡§¶]+$/, "").replace(/[.):;,]+$/, "");
  if (!/^\d{1,4}$/.test(value)) return null;
  return String(parseInt(value, 10));
}
function extractFragment(href) {
  if (!href) return null;
  const match = href.match(/#([A-Za-z_][\w:.\-]*)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
function maskDigits(fragment) {
  return fragment.replace(/\d+/g, "N");
}
function textOf(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}
function buildTargetMap(root) {
  const map = /* @__PURE__ */ new Map();
  root.querySelectorAll("[id]").forEach((el) => {
    const id = el.getAttribute("id");
    if (id && !map.has(id)) map.set(id, el);
  });
  root.querySelectorAll("a[name]").forEach((el) => {
    const name = el.getAttribute("name");
    if (name && !map.has(name)) map.set(name, el);
  });
  return map;
}
function identityOf(anchor, root, linkedIds) {
  let el = anchor;
  let hops = 0;
  while (el && el !== root && hops <= MAX_ID_HOPS) {
    const id = el.getAttribute("id") || el.getAttribute("name");
    if (id && linkedIds.has(id)) return id;
    el = el.parentElement;
    hops += 1;
  }
  return null;
}
function supAffinity(anchor) {
  return anchor.closest("sup") !== null || anchor.querySelector("sup") !== null;
}
function blockOf(el, root) {
  const block = el.closest("p, li, dd, td, blockquote") || el.closest("div, section") || el;
  if (block === root) return null;
  if (/^H[1-6]$/.test(block.tagName)) return null;
  return block;
}
function isBacklink(anchor, markerIds) {
  const fragment = extractFragment(anchor.getAttribute("href"));
  return fragment !== null && markerIds.has(fragment);
}
function definitionText(block, markerIds) {
  let length = textOf(block).length;
  block.querySelectorAll("a[href]").forEach((a) => {
    if (isBacklink(a, markerIds)) length -= textOf(a).length;
  });
  return length;
}
function resolveAnchorFootnotes(root) {
  const empty = (rejected) => ({ footnotes: [], tier: null, shape: null, rejected });
  const targets = buildTargetMap(root);
  if (targets.size === 0) return empty("no-edges");
  const order = /* @__PURE__ */ new Map();
  root.querySelectorAll("*").forEach((el, index) => order.set(el, index));
  const positionOf = (el) => order.get(el) ?? -1;
  const anchors = Array.from(root.querySelectorAll("a[href]"));
  const linkedIds = /* @__PURE__ */ new Set();
  anchors.forEach((a) => {
    const fragment = extractFragment(a.getAttribute("href"));
    if (fragment && targets.has(fragment)) linkedIds.add(fragment);
  });
  if (linkedIds.size === 0) return empty("no-edges");
  const edges = [];
  anchors.forEach((anchor) => {
    const targetId = extractFragment(anchor.getAttribute("href"));
    if (!targetId) return;
    const target = targets.get(targetId);
    if (!target || target === anchor) return;
    edges.push({ anchor, targetId, target, sourceId: identityOf(anchor, root, linkedIds) });
  });
  if (edges.length < MIN_COHORT) return empty("no-edges");
  const reciprocal = resolveReciprocal(root, edges, targets, positionOf);
  if (reciprocal) return reciprocal;
  return resolveOneWay(root, edges, positionOf);
}
function resolveReciprocal(root, edges, targets, positionOf) {
  const bySource = /* @__PURE__ */ new Map();
  edges.forEach((edge) => {
    if (!edge.sourceId) return;
    const list = bySource.get(edge.sourceId);
    if (list) list.push(edge);
    else bySource.set(edge.sourceId, [edge]);
  });
  const cohorts = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  edges.forEach((edge) => {
    if (!edge.sourceId) return;
    const back = (bySource.get(edge.targetId) || []).find((candidate) => candidate.targetId === edge.sourceId);
    if (!back) return;
    const tripKey = [edge.sourceId, edge.targetId].sort().join("\0");
    if (seen.has(tripKey)) return;
    seen.add(tripKey);
    const here = targets.get(edge.sourceId);
    if (!here) return;
    const key = [maskDigits(edge.sourceId), maskDigits(edge.targetId)].sort().join(" <-> ");
    const trip = {
      a: { id: edge.sourceId, anchor: edge.anchor, el: here },
      b: { id: edge.targetId, anchor: back.anchor, el: edge.target }
    };
    const list = cohorts.get(key);
    if (list) list.push(trip);
    else cohorts.set(key, [trip]);
  });
  if (cohorts.size === 0) return null;
  const allTrips = Array.from(cohorts.values()).flat();
  const shapes = Array.from(cohorts.keys());
  if (allTrips.length < MIN_COHORT) return { footnotes: [], tier: null, shape: null, rejected: "cohort" };
  const forward = allTrips.filter((t) => positionOf(t.a.anchor) < positionOf(t.b.anchor)).length / allTrips.length;
  const oriented = forward >= MIN_DIRECTION_AGREEMENT ? allTrips.map((t) => orient(t.a, t.b)) : forward <= 1 - MIN_DIRECTION_AGREEMENT ? allTrips.map((t) => orient(t.b, t.a)) : null;
  if (!oriented) return { footnotes: [], tier: null, shape: null, rejected: "direction" };
  const rejected = null;
  const resolved = buildCohort(root, oriented, positionOf);
  if (!resolved) return { footnotes: [], tier: null, shape: null, rejected: rejected ?? "density" };
  resolved.sort((a, b) => positionOf(a.definitionBlock) - positionOf(b.definitionBlock));
  return { footnotes: resolved, tier: "reciprocal", shape: shapes.join(", "), rejected: null };
}
function orient(marker, definition) {
  return {
    markerAnchor: marker.anchor,
    markerId: marker.id,
    definitionAnchorId: definition.id,
    definitionEl: definition.el
  };
}
function buildCohort(root, pairs, positionOf) {
  const markerIds = new Set(pairs.map((p) => p.markerId));
  const byDefinition = /* @__PURE__ */ new Map();
  for (const pair of pairs) {
    const block = blockOf(pair.definitionEl, root);
    if (!block) return null;
    const list = byDefinition.get(block);
    if (list) list.push(pair);
    else byDefinition.set(block, [pair]);
  }
  if (byDefinition.size < MIN_COHORT) return null;
  const blocks = Array.from(byDefinition.keys());
  for (const block of blocks) {
    if (blocks.some((other) => other !== block && block.contains(other))) return null;
  }
  const substantial = blocks.filter((b) => definitionText(b, markerIds) >= MIN_DEFINITION_TEXT).length;
  if (substantial / blocks.length < MIN_DEFINITION_TEXT_SHARE) return null;
  const entries = Array.from(byDefinition.entries()).sort(([a], [b]) => positionOf(a) - positionOf(b));
  const parsed = entries.map(([, group]) => {
    const first = group[0];
    if (!first) return null;
    return parseMarkerNumber(textOf(first.markerAnchor)) ?? lastDigits(first.markerId) ?? lastDigits(first.definitionAnchorId);
  });
  const usable = parsed.every((value) => value !== null) && new Set(parsed).size === parsed.length;
  const ordinals = usable ? parsed.map((value) => value) : entries.map((_entry, index) => String(index + 1));
  if (ordinalDensity(ordinals.map((n) => parseInt(n, 10))) < MIN_ORDINAL_DENSITY) return null;
  return entries.map(([block, group], index) => {
    const markers = new Set(group.map((p) => p.markerAnchor));
    const definitionId = group[0]?.definitionAnchorId;
    if (definitionId) {
      root.querySelectorAll("a[href]").forEach((anchor) => {
        if (markers.has(anchor) || block.contains(anchor)) return;
        if (extractFragment(anchor.getAttribute("href")) === definitionId) markers.add(anchor);
      });
    }
    return {
      ordinal: ordinals[index] ?? String(index + 1),
      markers: Array.from(markers).sort((a, b) => positionOf(a) - positionOf(b)),
      definitionBlock: block,
      backlinks: Array.from(block.querySelectorAll("a[href]")).filter((a) => isBacklink(a, markerIds))
    };
  });
}
function lastDigits(value) {
  const match = (value || "").match(/(\d+)(?!.*\d)/);
  return match?.[1] ? String(parseInt(match[1], 10)) : null;
}
function resolveOneWay(root, edges, positionOf) {
  const empty = (rejected2) => ({ footnotes: [], tier: null, shape: null, rejected: rejected2 });
  const cohorts = /* @__PURE__ */ new Map();
  edges.forEach((edge) => {
    const key = maskDigits(edge.targetId);
    const list = cohorts.get(key);
    if (list) list.push(edge);
    else cohorts.set(key, [edge]);
  });
  let best = null;
  let rejected = "cohort";
  for (const [shape, group] of cohorts) {
    if (group.length < MIN_COHORT) continue;
    if (!group.every((e) => positionOf(e.anchor) < positionOf(e.target))) {
      rejected = "direction";
      continue;
    }
    const markersLookRight = group.every((e) => {
      const text = textOf(e.anchor);
      if (text.length > MAX_MARKER_TEXT) return false;
      return supAffinity(e.anchor) || parseMarkerNumber(text) !== null;
    });
    if (!markersLookRight) {
      rejected = "direction";
      continue;
    }
    const byDefinition = /* @__PURE__ */ new Map();
    for (const edge of group) {
      const block = blockOf(edge.target, root);
      if (!block) {
        continue;
      }
      const list = byDefinition.get(block);
      if (list) list.push(edge);
      else byDefinition.set(block, [edge]);
    }
    if (byDefinition.size < MIN_COHORT) {
      rejected = "cohort";
      continue;
    }
    const blocks = Array.from(byDefinition.keys());
    if (!blocks.every((b) => textOf(b).length >= MIN_DEFINITION_TEXT)) {
      rejected = "cohort";
      continue;
    }
    const positions = blocks.map(positionOf).sort((a, b) => a - b);
    const median = positions[Math.floor(positions.length / 2)] ?? 0;
    const allPositions = group.map((e) => positionOf(e.anchor)).concat(positions).sort((a, b) => a - b);
    const overallMedian = allPositions[Math.floor(allPositions.length / 2)] ?? 0;
    const oneParent = new Set(blocks.map((b) => b.parentElement)).size === 1;
    if (!oneParent && median <= overallMedian) {
      rejected = "direction";
      continue;
    }
    if (looksLikeBibliography(root, blocks)) {
      rejected = "bibliography";
      continue;
    }
    const entries = Array.from(byDefinition.entries()).sort(([a], [b]) => positionOf(a) - positionOf(b));
    const parsed = entries.map(([, g]) => {
      const first = g[0];
      return first ? parseMarkerNumber(textOf(first.anchor)) ?? lastDigits(first.targetId) : null;
    });
    const usable = parsed.every((v) => v !== null) && new Set(parsed).size === parsed.length;
    const ordinals = usable ? parsed.map((v) => v) : entries.map((_e, i) => String(i + 1));
    const nums = ordinals.map((n) => parseInt(n, 10));
    if (ordinalDensity(nums) < MIN_ORDINAL_DENSITY) {
      rejected = "density";
      continue;
    }
    if (Math.min(...nums) > 2) {
      rejected = "density";
      continue;
    }
    const footnotes = entries.map(([block, g], index) => ({
      ordinal: ordinals[index] ?? String(index + 1),
      markers: g.map((e) => e.anchor).sort((a, b) => positionOf(a) - positionOf(b)),
      definitionBlock: block,
      backlinks: []
    }));
    if (!best || footnotes.length > best.footnotes.length) best = { shape, footnotes };
  }
  if (!best) return empty(rejected);
  return { footnotes: best.footnotes, tier: "one-way", shape: best.shape, rejected: null };
}
function looksLikeBibliography(root, blocks) {
  if (blocks.length === 0) return false;
  const structured = blocks.filter((b) => hasReferenceStructure(textOf(b))).length / blocks.length;
  if (structured >= 0.6) return true;
  const heading = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")).find((h) => isReferenceHeading(h.textContent));
  if (!heading) return false;
  const after = blocks.filter((b) => Boolean(heading.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).length / blocks.length;
  return after >= 0.5 && structured >= 0.3;
}
var RESIDUE_RE = /^[\s ^↩↑←↩↰[\](){}.,;:•·|-]*$/;
function applyAnchorFootnotes(resolved, doc = document) {
  resolved.forEach((footnote) => {
    footnote.markers.forEach((anchor) => {
      const sup = doc.createElement("sup");
      sup.setAttribute("fn-count-id", footnote.ordinal);
      sup.textContent = footnote.ordinal;
      const parent = anchor.parentElement;
      const wrapping = parent && parent.tagName === "SUP" && parent.children.length === 1 && parent.children[0] === anchor;
      (wrapping ? parent : anchor).replaceWith(sup);
    });
    footnote.backlinks.forEach((link) => {
      let ancestor = link.parentElement;
      link.remove();
      while (ancestor && ancestor !== footnote.definitionBlock && footnote.definitionBlock.contains(ancestor) && ancestor.children.length === 0 && RESIDUE_RE.test(ancestor.textContent || "")) {
        const next = ancestor.parentElement;
        ancestor.remove();
        ancestor = next;
      }
    });
  });
}

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
    this.skipPlainTextFootnoteScan = false;
    const anchorResult = resolveAnchorFootnotes(dom);
    if (anchorResult.footnotes.length > 0) {
      console.log(`  - \u{1F517} Anchor footnote system (${anchorResult.tier}, ${anchorResult.shape}): ${anchorResult.footnotes.length} notes`);
      applyAnchorFootnotes(anchorResult.footnotes);
      this.skipPlainTextFootnoteScan = true;
      anchorResult.footnotes.forEach((resolved) => {
        const identifier = resolved.ordinal;
        const uniqueId = this.generateFootnoteId(bookId, identifier);
        const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);
        footnotes.push(this.createFootnote(
          uniqueId,
          resolved.definitionBlock.innerHTML.trim().replace(/^\s*\[?\d+\]?[.)]?\s*/, ""),
          identifier,
          uniqueRefId,
          `anchor-${anchorResult.tier}`
        ));
        const parentList = resolved.definitionBlock.parentElement;
        resolved.definitionBlock.remove();
        if (parentList && (parentList.tagName === "UL" || parentList.tagName === "OL") && parentList.children.length === 0) {
          parentList.remove();
        }
      });
      return footnotes;
    }
    const refIdentifiers = /* @__PURE__ */ new Set();
    const supElements = dom.querySelectorAll("sup");
    supElements.forEach((sup) => {
      const identifier = parseMarkerNumber(sup.textContent) || sup.getAttribute("fn-count-id");
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
          const anchorText = parseMarkerNumber(firstAnchor.textContent);
          if (anchorText && refIdentifiers.has(anchorText) && !potentialParagraphDefs.has(anchorText)) {
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
    if (refIdentifiers.size === 0 && !this.hasReferenceSectionHeading(dom)) {
      const bracketDefs = /* @__PURE__ */ new Map();
      dom.querySelectorAll("p, li").forEach((el) => {
        const elText = (el.textContent || "").trim();
        const defNumber = elText.match(/^\[(\d+)\]\s+\S/)?.[1];
        if (defNumber && !bracketDefs.has(defNumber)) {
          bracketDefs.set(defNumber, el);
        }
      });
      const markerIds = /* @__PURE__ */ new Set();
      dom.querySelectorAll("p, li").forEach((el) => {
        const elText = el.textContent || "";
        const markerPattern = /\[(\d+)\]/g;
        let m;
        while ((m = markerPattern.exec(elText)) !== null) {
          if (m.index === 0) continue;
          const markerNumber = m[1];
          if (markerNumber) markerIds.add(markerNumber);
        }
      });
      const defNumbers = [...bracketDefs.keys()].map(Number).sort((a, b) => a - b);
      const isContiguous = defNumbers.length > 0 && defNumbers[0] === 1 && defNumbers[defNumbers.length - 1] === defNumbers.length;
      const allMarkersResolve = markerIds.size > 0 && [...markerIds].every((id) => bracketDefs.has(id));
      if (isContiguous && allMarkersResolve) {
        bracketDefs.forEach((el, id) => {
          refIdentifiers.add(id);
          potentialParagraphDefs.set(id, el);
        });
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
        let content = pElement.innerHTML.trim().replace(/^\s*<a[^>]*>\s*\d+\s*<\/a>\s*/, "").replace(/^\s*\d+[\.)]\s*/, "");
        if (/^\s*\[\d+\]/.test(pElement.textContent)) {
          content = this.stripLeadingBracketNumber(pElement);
        }
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
   * Does the document contain a references/bibliography section heading?
   * Used to decide ownership of "[N]" markers: with such a heading they are
   * numeric citations into a reference list, not endnote markers.
   */
  hasReferenceSectionHeading(dom) {
    return this.findReferenceSectionHeading(dom) !== null;
  }
  /**
   * Find the document's references/bibliography heading, ANYWHERE in the tree.
   *
   * Clipboard payloads are essentially always wrapped in a container <div>, and
   * extraction runs at Stage 3 — BEFORE transformStructure() unwraps those
   * wrappers — so the old `dom.children` walk found nothing on any real web
   * paste. That made the heading branch dead code and pushed every paste onto
   * the heading-less path, which is how book_1788040795553 got a References
   * section built out of its own body prose.
   */
  findReferenceSectionHeading(dom) {
    const headings = Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    return headings.find((el) => isReferenceHeading(el.textContent)) || null;
  }
  /**
   * Remove a leading "[N]" identifier from a definition element's first
   * non-empty text node and return the resulting innerHTML — works even when
   * the prefix is nested inside inline wrappers like <span>/<b>.
   */
  stripLeadingBracketNumber(element) {
    const clone = element.cloneNode(true);
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent || "";
      if (!text.trim()) continue;
      node.textContent = text.replace(/^\s*\[\d+\]\s*/, "");
      break;
    }
    return clone.innerHTML.trim();
  }
  /**
   * Extract references.
   *
   * STRATEGY 1 — anchor-based (`<a name="ref…">`): structural, trusted outright.
   * STRATEGY 2 — shape + cohort, via utils/reference-detection.ts.
   *
   * Strategy 2 used to be "find a References heading among dom.children, and
   * failing that scan EVERY paragraph bottom-up keeping anything that starts
   * with a capital and contains four digits". Both halves were broken: the
   * heading walk could never see through the clipboard's wrapper <div>, and the
   * fallback predicate accepts ordinary news prose ("…faced something similar in
   * 1773 when Parliament…"). It also copied rather than moved, so every false
   * positive appeared twice — once in the body, once under a fabricated
   * "References" heading. That is the book_1788040795553 report.
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];
    const anchorRefs = Array.from(dom.querySelectorAll('a[name^="ref"]'));
    if (anchorRefs.length > 0) {
      anchorRefs.forEach((anchor) => {
        const container = anchor.closest("p, li") || anchor.parentElement;
        if (!container || container === dom) return;
        if (container.querySelectorAll('a[name^="ref"]').length !== 1) return;
        references.push({
          // innerHTML, NOT outerHTML — appendStaticSections hosts this inside a
          // fresh <p> and a block cannot nest there.
          content: container.innerHTML,
          originalText: (container.textContent || "").trim(),
          type: "anchor-based",
          needsKeyGeneration: true,
          originalAnchorId: anchor.getAttribute("name")
        });
        const parent = container.parentElement;
        container.remove();
        if (parent && (parent.tagName === "UL" || parent.tagName === "OL") && parent.children.length === 0) {
          parent.remove();
        }
      });
      if (references.length > 0) {
        console.log(`  - Extracted ${references.length} anchor-based references`);
        return references;
      }
    }
    const referenceHeading = this.findReferenceSectionHeading(dom);
    const candidates = referenceHeading ? this.collectSectionBlocks(dom, referenceHeading) : this.collectCandidateBlocks(dom);
    const accepted = collectReferenceRun(candidates, { headingAnchored: Boolean(referenceHeading) });
    if (accepted.length === 0) {
      console.log(
        referenceHeading ? "  - References heading found but no entries matched" : "  - No reference section detected"
      );
      return references;
    }
    accepted.forEach((el) => {
      references.push(...this.buildReferencesFromBlock(el));
      el.remove();
    });
    if (referenceHeading && references.length > 0) referenceHeading.remove();
    console.log(`  - Extracted ${references.length} references`);
    return references;
  }
  /**
   * Every block that could be a bibliography entry, in document order, with
   * nested duplicates dropped (a <p> inside an <li> is not a second candidate).
   */
  collectCandidateBlocks(dom) {
    const blocks = Array.from(dom.querySelectorAll("p, li"));
    const seen = new Set(blocks);
    return blocks.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== dom) {
        if (seen.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }
  /**
   * The blocks belonging to a reference section, walked in document order from
   * its heading to the next same-or-higher-level heading.
   *
   * Two wrinkles ported from bibliography.py:75-118. A LOWER-level heading is an
   * alphabetical marker inside the bibliography ("A", "B", …) and is skipped. A
   * same-or-higher-level heading normally ends the section, unless the blocks
   * right after it are themselves reference-like with their year near the start
   * — then it is an OCR/markup artifact and collection continues.
   */
  collectSectionBlocks(dom, heading) {
    const ordered = Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li"));
    const start = ordered.indexOf(heading);
    if (start === -1) return [];
    const headingLevel = parseInt(heading.tagName.slice(1), 10);
    const candidates = new Set(this.collectCandidateBlocks(dom));
    const collected = [];
    for (let i = start + 1; i < ordered.length; i++) {
      const el = ordered[i];
      if (!el) continue;
      if (/^H[1-6]$/.test(el.tagName)) {
        if (parseInt(el.tagName.slice(1), 10) > headingLevel) continue;
        if (this.looksLikeArtifactHeading(ordered, i)) continue;
        break;
      }
      if (candidates.has(el)) collected.push(el);
    }
    return collected;
  }
  /** True when the blocks following `ordered[index]` read as more references. */
  looksLikeArtifactHeading(ordered, index) {
    let total = 0;
    let refLike = 0;
    for (let i = index + 1; i < ordered.length && total < 3; i++) {
      const el = ordered[i];
      if (!el || /^H[1-6]$/.test(el.tagName)) continue;
      total += 1;
      const text = (el.textContent || "").trim();
      if (isReferenceShaped(text) && hasEarlyYear(text)) refLike += 1;
    }
    return total >= 2 && refLike >= 2;
  }
  /**
   * Turn one accepted block into reference objects, splitting <br>-separated
   * entries (incl. attribute-bearing tags, e.g. DeepL's `<br data-dl-uid="1">`).
   * Only splits when EVERY part reads as an entry, so a stray <br> inside a
   * single reference cannot shred it.
   */
  buildReferencesFromBlock(el) {
    const html = el.innerHTML;
    if (/<br\b[^>]*>/i.test(html)) {
      const parts = html.split(/<br\b[^>]*>/i).map((s) => s.trim()).filter((s) => s);
      if (parts.length > 1) {
        const texts = parts.map((part) => {
          const temp = document.createElement("div");
          temp.innerHTML = part;
          return (temp.textContent || "").trim();
        });
        if (texts.every((text) => isReferenceShaped(text))) {
          return parts.map((part, i) => ({
            content: part,
            originalText: texts[i],
            type: "html-br-split",
            needsKeyGeneration: true
          }));
        }
      }
    }
    return [{
      content: html,
      originalText: (el.textContent || "").trim(),
      type: "html-paragraph",
      needsKeyGeneration: true
    }];
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
    const headings = Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const referenceHeading = headings.find((h) => isReferenceHeading(h.textContent));
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
        // innerHTML, NOT outerHTML — appendStaticSections hosts this inside a
        // fresh <p>, and a nested block splits into an empty tagged node plus an
        // untagged orphan on the next reparse (see PATH 1's note above).
        content: p.innerHTML,
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
        if (isReferenceHeading(heading.textContent)) {
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
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (/^H[1-6]$/.test(el.tagName) && isReferenceHeading(el.textContent)) {
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
        if (isReferenceHeading(heading.textContent)) {
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

// resources/js/paste/format-processors/bristol-up-processor.ts
var BristolUPProcessor = class extends BaseFormatProcessor {
  constructor() {
    super("bristol-up");
  }
  /**
   * Footnote definitions. The platform's real note markup (seen on GSCJ) is a
   * `div.footnoteGroup` holding a "Note"/"Notes" <h2> plus one
   * `<div id="fn1" class="footnote">` per note — lowercase `fn` ids, unpadded.
   * The FN-prefixed selectors are kept for the Silverchair-flavoured variant this
   * was originally written against; attribute selectors are case-sensitive, so
   * both spellings must be listed.
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const els = dom.querySelectorAll(
      'div.footnote[id^="FN"], li.footnote[id^="FN"], .fnSection .footnote, div.footnote[id^="fn"], .footnoteGroup .footnote'
    );
    els.forEach((element) => {
      const m = (element.getAttribute("id") || "").match(/fn0*(\d+)/i);
      if (!m) return;
      if (element.closest("table, figure, .table-wrap, .fig")) return;
      const identifier = parseInt(m[1] ?? "", 10).toString();
      const clone = element.cloneNode(true);
      clone.querySelectorAll('.label, .fn-label, a[href^="#ref_FN"], a[href^="#ref_fn"]').forEach((el) => el.remove());
      clone.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
      const html = clone.innerHTML.trim();
      if (!html) return;
      const footnoteId = this.generateFootnoteId(bookId, identifier);
      footnotes.push(this.createFootnote(
        footnoteId,
        html,
        identifier,
        this.generateFootnoteRefId(footnoteId),
        "bristol-up"
      ));
      element.remove();
    });
    dom.querySelectorAll(".footnoteGroup").forEach((group) => {
      if (!group.querySelector(".footnote")) group.remove();
    });
    return footnotes;
  }
  /** In-text note refs: <a href="#fn1"> / <a href="#FN0001">. Map to the app's <sup fn-count-id> form. */
  linkFootnotes(dom, footnotes) {
    if (!footnotes || footnotes.length === 0) return;
    dom.querySelectorAll('a[href^="#FN"], a[href^="#fn"]').forEach((link) => {
      const m = (link.getAttribute("href") || "").match(/#fn0*(\d+)/i);
      if (!m) return;
      const identifier = parseInt(m[1] ?? "", 10).toString();
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
   * References: `div.reference[id^="CIT"]`, clean text in `p.citationText`.
   * referenceId IS the CIT id, so the in-text `href="#CIT0026"` anchors map exactly.
   */
  async extractReferences(dom, bookId) {
    const references = [];
    const seen = /* @__PURE__ */ new Set();
    dom.querySelectorAll('.reference[id^="CIT"]').forEach((item) => {
      const citId = item.getAttribute("id");
      if (!citId || seen.has(citId)) return;
      const citation = item.querySelector("p.citationText");
      if (!citation) return;
      const clone = citation.cloneNode(true);
      clone.querySelectorAll(".debug, .citationActions, a.googleScholar, a.exportCitation").forEach((el) => el.remove());
      const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 10) return;
      seen.add(citId);
      references.push({
        content: clone.innerHTML.trim() || text,
        originalText: text,
        type: "bristol-up-bibliography",
        needsKeyGeneration: false,
        referenceId: citId,
        refKeys: [citId],
        originalAnchorId: citId
      });
    });
    return references;
  }
  /** In-text citations: <a href="#CIT0026"> — exact id, so link directly. */
  linkCitations(dom, references) {
    super.linkCitations(dom, references);
    const refIds = new Set((references || []).map((r) => r.referenceId));
    dom.querySelectorAll('a[href^="#CIT"]').forEach((link) => {
      const citId = (link.getAttribute("href") || "").slice(1);
      if (!refIds.has(citId)) return;
      link.setAttribute("href", `#${citId}`);
      link.setAttribute("class", "in-text-citation");
      ["id", "onclick", "target", "title", "data-popover-anchor"].forEach((attr) => link.removeAttribute(attr));
      link.removeAttribute("style");
    });
  }
  /**
   * The article's front matter — title, authors, affiliation, abstract, keywords — sits OUTSIDE
   * `#articleBody`, in the page's metadata card ABOVE it. Scoping to the body therefore threw all
   * of it away and the book opened cold on "Key messages" (the PDF lane, which sees the printed
   * page, keeps it). So it is rebuilt here from the header markup and prepended.
   *
   * Deliberately unlabelled — no "Abstract" heading — because the printed article presents it as
   * the opening paragraph, and the two lanes are meant to be compared side by side.
   */
  buildArticleHeader(dom) {
    const box = document.createElement("div");
    const titleEl = dom.querySelector(
      '[data-testid="block-title"] h1, [data-testid="block-title"] h2, [data-testid="block-title"] .title'
    );
    const title = titleEl?.textContent?.trim();
    if (title) {
      const h1 = document.createElement("h1");
      h1.textContent = title;
      box.appendChild(h1);
    }
    const authors = [];
    dom.querySelectorAll('[data-testid="author-name"]').forEach((el) => {
      const name = el.textContent?.trim();
      if (name && !authors.includes(name)) authors.push(name);
    });
    if (authors.length) {
      const p = document.createElement("p");
      p.textContent = authors.join(", ");
      box.appendChild(p);
    }
    const affiliations = [];
    dom.querySelectorAll(".contributor-details-pop-up-affiliation").forEach((el) => {
      const institution = el.querySelector(".institution")?.textContent?.trim() ?? "";
      const country = el.querySelector(".country")?.textContent?.trim() ?? "";
      const affiliation = [institution, country].filter(Boolean).join(", ");
      if (affiliation && !affiliations.includes(affiliation)) affiliations.push(affiliation);
    });
    for (const affiliation of affiliations) {
      const p = document.createElement("p");
      p.textContent = affiliation;
      box.appendChild(p);
    }
    const abstract = dom.querySelector("section.abstract, .abstract_or_excerpt section");
    if (abstract) {
      const clone = abstract.cloneNode(true);
      clone.querySelectorAll(".counterData, script, style").forEach((el) => el.remove());
      const paragraphs = clone.querySelectorAll("p");
      if (paragraphs.length) {
        paragraphs.forEach((p) => box.appendChild(p.cloneNode(true)));
      } else {
        const text = clone.textContent?.trim();
        if (text) {
          const p = document.createElement("p");
          p.textContent = text;
          box.appendChild(p);
        }
      }
    }
    const keywords = dom.querySelector("dd.keywords")?.textContent?.replace(/\s+/g, " ").trim();
    if (keywords) {
      const p = document.createElement("p");
      p.textContent = `Key words: ${keywords}`;
      box.appendChild(p);
    }
    return box.innerHTML;
  }
  /**
   * Scope to `#articleBody` — re-attaching the front matter that lives above it — and strip the
   * reference block (the base class re-appends references cleanly) plus the hidden
   * structured-citation duplicates and export widgets.
   */
  async transformStructure(dom, bookId) {
    const header = this.buildArticleHeader(dom);
    const article = dom.querySelector("#articleBody, .articleBody");
    if (article) {
      dom.innerHTML = header + article.innerHTML;
    } else if (header) {
      dom.insertAdjacentHTML("afterbegin", header);
    }
    dom.querySelectorAll(
      '.refSection, .content-references-list, .citationActions, .debug, a.googleScholar, a.exportCitation, .c-IconButton, [data-popover], [role="tooltip"]'
    ).forEach((el) => el.remove());
    dom.querySelectorAll("button").forEach((el) => el.remove());
    unwrapContainers(dom);
  }
};

// resources/js/paste/format-detection/format-registry.ts
function defineFormat(definition) {
  const signature = definition.signature ?? definition.selectors ?? [];
  const supporting = definition.supporting ?? [];
  const domain = definition.domain ?? [];
  return {
    signature,
    supporting,
    domain,
    selectors: [...signature, ...supporting, ...domain],
    processor: definition.processor,
    priority: definition.priority,
    description: definition.description
  };
}
var FORMAT_REGISTRY = {
  // Science Direct - Priority 5
  "science-direct": defineFormat({
    signature: [
      '[data-xocs-content-id^="b"]',
      ".anchor.anchor-primary[data-sd-ui-side-panel-opener]"
    ],
    // `class="reference"` is a plausible class on any site.
    supporting: ["span.reference[id]"],
    processor: ScienceDirectProcessor,
    priority: 5,
    description: "Science Direct content with XOCS data attributes"
  }),
  // MIT Press (direct.mit.edu, Silverchair) - Priority 5
  // Distinguished from OUP by data-content-id / data-modal-source-id (OUP uses
  // bare content-id), so it must be checked before OUP.
  "mit-press": defineFormat({
    signature: [
      'a[data-modal-source-id^="bib"]',
      '[data-content-id^="bib"]',
      '.fn[content-id^="fn"]'
    ],
    processor: MitPressProcessor,
    priority: 5,
    description: "MIT Press (direct.mit.edu) Silverchair content with data-content-id attributes"
  }),
  // OUP (Oxford University Press) - Priority 4
  "oup": defineFormat({
    signature: [
      '[content-id^="bib"]',
      ".js-splitview-ref-item",
      '.footnote[content-id^="fn"]'
    ],
    processor: OupProcessor,
    priority: 4,
    description: "Oxford University Press content with content-id attributes"
  }),
  // Springer - Priority 4
  "springer": defineFormat({
    signature: [
      '[id^="ref-CR"]',
      'a[href*="#ref-CR"]'
    ],
    // `Fn`-prefixed ids are SELF-INFLICTED: base-processor mints footnote ids as
    // `Fn{timestamp}_{rand}`, so re-pasting Hyperlit's own output used to detect
    // as Springer. Demoting the id selector without its href twin would be
    // cosmetic, so both move.
    supporting: [
      '[id^="Fn"]',
      'a[href*="#Fn"]',
      'a[data-track="click"][data-track-label="link"][href*="springer.com"]'
    ],
    processor: SpringerProcessor,
    priority: 4,
    description: "Springer Nature content with ref-CR and Fn ID patterns"
  }),
  // Substack - Priority 4
  "substack": defineFormat({
    signature: [
      'a[data-component-name="FootnoteAnchorToDOM"]',
      '[id^="footnote-anchor-"]',
      'a[href*="substack.com"][href*="#footnote-"]'
    ],
    supporting: [".footnote-content"],
    processor: SubstackProcessor,
    priority: 4,
    description: "Substack newsletter content with FootnoteAnchorToDOM components"
  }),
  // Wiley Online Library - Priority 4
  "wiley": defineFormat({
    signature: [
      "a.bibLink",
      // citation links with bibLink class
      "[data-bib-id]",
      // reference list items
      'a.tab-link[href^="#"][data-tab="pane-pcw-references"]'
      // links into the references pane
    ],
    domain: ['a[href*="onlinelibrary.wiley"]'],
    processor: WileyProcessor,
    priority: 4,
    description: "Wiley Online Library journals with bibId-based citations"
  }),
  // Cambridge - Priority 3
  "cambridge": defineFormat({
    signature: [
      ".xref.fn",
      ".circle-list__item__grouped__content",
      '[id^="reference-"][id$="-content"]'
    ],
    processor: CambridgeProcessor,
    priority: 3,
    description: "Cambridge University Press content with xref.fn links"
  }),
  // Taylor & Francis - Priority 4
  "taylor-francis": defineFormat({
    signature: [
      ".ref-lnk.lazy-ref.bibr",
      ".NLM_sec",
      ".hlFld-Abstract",
      'li[id^="CIT"]'
    ],
    domain: ['a[href*="tandfonline.com"]'],
    processor: TaylorFrancisProcessor,
    priority: 4,
    description: "Taylor & Francis content with CIT IDs"
  }),
  // Bristol University Press Digital - Priority 5
  // Must outrank sage (3): a BUP page matches sage's generic `[role="listitem"]` selector and
  // was being processed by SageProcessor, which left the hidden mixed-citation duplicates and
  // the whole surrounding site in the imported book. (The signature/supporting split below is
  // the real fix for that class of bug; the priority ordering is kept for the tie-break.)
  "bristol-up": defineFormat({
    signature: [
      ".content-references-list",
      '.reference[id^="CIT"]'
    ],
    // A generic CMS id — any site can have one.
    supporting: ["#articleBody"],
    domain: ['a[href*="bristoluniversitypressdigital.com"]'],
    processor: BristolUPProcessor,
    priority: 5,
    description: "Bristol University Press Digital (Global Social Challenges Journal et al.)"
  }),
  // Sage - Priority 3
  "sage": defineFormat({
    signature: [],
    // NONE of these is Sage-specific. `[role="doc-noteref"]` is the standard
    // W3C DPUB-ARIA role for a footnote reference — Pandoc and every other
    // conforming generator emits it, so it identifies "this page has footnotes",
    // not "this page is Sage". `.citations`, `.ref` and `[role="listitem"]` fire
    // on a large slice of the web; `[role="listitem"]` is on every Webflow
    // Collection List. Sage is therefore identified by its domain alone.
    supporting: ['a[role="doc-noteref"]', ".citations", ".ref", '[role="listitem"]'],
    domain: ['a[href*="sagepub.com"]'],
    processor: SageProcessor,
    priority: 3,
    description: "Sage Publications content"
  }),
  // General - Priority 0 (fallback, always matches)
  "general": defineFormat({
    selectors: [],
    // Empty = matches anything (fallback)
    processor: GeneralProcessor,
    priority: 0,
    description: "General format (fallback for unrecognized formats)"
  })
};
function getFormatsByPriority() {
  return Object.entries(FORMAT_REGISTRY).sort(([, a], [, b]) => b.priority - a.priority);
}
function getFormatConfig(formatType) {
  return FORMAT_REGISTRY[formatType] || null;
}

// resources/js/paste/format-detection/format-detector.ts
function countMatches(root, selectors, formatType) {
  const hits = [];
  for (const selector of selectors) {
    try {
      const count = root.querySelectorAll(selector).length;
      if (count > 0) hits.push({ selector, count });
    } catch (error) {
      console.warn(`Invalid selector "${selector}" for format "${formatType}":`, error);
    }
  }
  return hits;
}
function scoreFormats(root) {
  return getFormatsByPriority().map(([formatType, config]) => {
    const signatureHits = countMatches(root, config.signature, formatType);
    const supportingHits = countMatches(root, config.supporting, formatType);
    const domainHits = countMatches(root, config.domain, formatType);
    const totalMatches = [...signatureHits, ...supportingHits, ...domainHits].reduce((sum, hit) => sum + hit.count, 0);
    return { formatType, config, signatureHits, supportingHits, domainHits, totalMatches };
  });
}
function logDetection(score, label, hits) {
  console.log(`\u{1F4DA} Detected ${score.formatType} format${label}:`);
  console.log(`  - Matched ${hits.length}/${score.config.selectors.length} selector patterns`);
  console.log(`  - Total elements: ${score.totalMatches}`);
  console.log(`  - Priority: ${score.config.priority}`);
  console.log(`  - Description: ${score.config.description}`);
  hits.forEach((hit) => console.log(`    \u2713 ${hit.selector} (${hit.count} matches)`));
  if (score.supportingHits.length > 0 && hits !== score.supportingHits) {
    const corroborating = score.supportingHits.map((h) => `${h.selector} (${h.count})`).join(", ");
    console.log(`    \xB7 corroborating: ${corroborating}`);
  }
}
function detectFormat(htmlContent) {
  if (!htmlContent || typeof htmlContent !== "string") {
    console.log("\u{1F4DA} No HTML content provided, using general format");
    return "general";
  }
  const tempDiv = createTempDOM(htmlContent);
  console.log("\u{1F50D} Detecting format from pasted content...");
  let domainOnlyFallback = null;
  for (const score of scoreFormats(tempDiv)) {
    if (score.config.selectors.length === 0) {
      if (domainOnlyFallback) {
        logDetection(domainOnlyFallback, " (domain-only fallback)", domainOnlyFallback.domainHits);
        return domainOnlyFallback.formatType;
      }
      console.log(`\u{1F4DA} Using fallback format: ${score.formatType}`);
      return score.formatType;
    }
    if (score.signatureHits.length > 0) {
      logDetection(score, "", score.signatureHits);
      return score.formatType;
    }
    if (score.domainHits.length > 0 && !domainOnlyFallback) {
      console.log(`  \u23F3 ${score.formatType}: domain-only match, saving as fallback`);
      domainOnlyFallback = score;
      continue;
    }
    if (score.supportingHits.length > 0) {
      const seen = score.supportingHits.map((h) => `${h.selector} (${h.count})`).join(", ");
      console.log(`  \u23ED\uFE0F ${score.formatType}: only generic selectors matched, not decisive \u2014 ${seen}`);
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
  const tempDiv = createTempDOM(htmlContent || "");
  const allResults = scoreFormats(tempDiv).map((score) => ({
    formatType: score.formatType,
    // A format is only "matched" in the sense that DECIDES anything when a
    // signature or domain selector hit; generic corroboration does not count.
    matched: score.config.selectors.length === 0 || score.signatureHits.length > 0 || score.domainHits.length > 0,
    matchCount: score.totalMatches,
    priority: score.config.priority,
    description: score.config.description,
    matchedSelectors: [...score.signatureHits, ...score.supportingHits, ...score.domainHits].map((hit) => ({ selector: hit.selector, count: hit.count })),
    signatureSelectors: score.signatureHits.map((hit) => hit.selector),
    supportingSelectors: score.supportingHits.map((hit) => hit.selector),
    domainSelectors: score.domainHits.map((hit) => hit.selector)
  }));
  return {
    detectedFormat: detectFormat(htmlContent),
    allResults
  };
}
export {
  detectFormat,
  detectFormatVerbose,
  getProcessorForContent,
  scoreFormats
};
