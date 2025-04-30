import { ContainerManager } from "./container-manager.js";
import { openDatabase, getNodeChunksFromIndexedDB } from "./cache-indexedDB.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";
import { book } from "./app.js";
import { htmlToText } 
  from 'https://cdn.skypack.dev/html-to-text';
  import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink
} from 'https://cdn.skypack.dev/docx@8.3.0';

function getRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/**
 * Build the inner-HTML for the source container:
 *  - fetch bibtex from IndexedDB
 *  - format it to a citation
 *  - append a Download section with two buttons
 */
async function buildSourceHtml(currentBookId) {
  const db = await openDatabase();
  const record = await getRecord(db, "library", book);

  console.log("buildSourceHtml got:", { book, record });

  const bibtex = record?.bibtex || "";
  const citation = formatBibtexToCitation(bibtex).trim();

  return `
    <div class="scroller">
    <div class="citation">${citation}</div>

    <br/>
    
    <button id="download-md" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      viewBox="0 0 24 24"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
        <!-- no <rect> or white box here; just the two paths -->
        <path
          fill="currentColor"
          d="M14.481 14.015c-.238 0-.393.021-.483.042v3.089c.091.021.237.021.371.021.966.007 1.597-.525 1.597-1.653.007-.981-.568-1.499-1.485-1.499z"
        />
        <path
          fill="currentColor"
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-2.934 15.951-.07-1.807a53.142 53.142 0 0 1-.042-1.94h-.021a26.098 26.098 0 0 1-.525 1.828l-.574 1.842H9l-.504-1.828a21.996 21.996 0 0 1-.428-1.842h-.013c-.028.638-.049 1.366-.084 1.954l-.084 1.793h-.988L7.2 13.23h1.422l.462 1.576c.147.546.295 1.135.399 1.688h.021a39.87 39.87 0 0 1 .448-1.694l.504-1.569h1.394l.26 4.721h-1.044zm5.25-.56c-.498.413-1.253.609-2.178.609a9.27 9.27 0 0 1-1.212-.07v-4.636a9.535 9.535 0 0 1 1.443-.099c.896 0 1.478.161 1.933.505.49.364.799.945.799 1.778 0 .904-.33 1.528-.785 1.913zM14 9h-1V4l5 5h-4z"
        />
      </svg>
      </div>
    </button>

    
    <button id="download-docx" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      viewBox="0 0 31.004 31.004"
      preserveAspectRatio="xMidYMid meet"  
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="currentColor">
        <!-- Remove inline style="fill:#030104;" -->
        <path d="M22.399,31.004V26.49c0-0.938,0.758-1.699,1.697-1.699l3.498-0.1L22.399,31.004z"/>
        <path d="M25.898,0H5.109C4.168,0,3.41,0.76,3.41,1.695v27.611c0,0.938,0.759,1.697,1.699,1.697h15.602v-6.02
          c0-0.936,0.762-1.697,1.699-1.697h5.185V1.695C27.594,0.76,26.837,0,25.898,0z
          M24.757,14.51c0,0.266-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.219-0.658-0.484v-0.807
          c0-0.268,0.295-0.484,0.658-0.484h17.535c0.363,0,0.656,0.217,0.656,0.484L24.757,14.51z
          M24.757,17.988c0,0.27-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.215-0.658-0.484v-0.805
          c0-0.268,0.295-0.486,0.658-0.486h17.535c0.363,0,0.656,0.219,0.656,0.486L24.757,17.988z
          M24.757,21.539c0,0.268-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.217-0.658-0.484v-0.807
          c0-0.268,0.295-0.486,0.658-0.486h17.535c0.363,0,0.656,0.219,0.656,0.486L24.757,21.539z
          M15.84,25.055c0,0.266-0.155,0.48-0.347,0.48H6.255c-0.192,0-0.348-0.215-0.348-0.48v-0.809
          c0-0.266,0.155-0.484,0.348-0.484h9.238c0.191,0,0.347,0.219,0.347,0.484V25.055z
          M12.364,11.391L10.68,5.416l-1.906,5.975H8.087c0,0-2.551-7.621-2.759-7.902
          C5.194,3.295,4.99,3.158,4.719,3.076V2.742h3.783v0.334c-0.257,0-0.434,0.041-0.529,0.125
          s-0.144,0.18-0.144,0.287c0,0.102,1.354,4.193,1.354,4.193l1.058-3.279c0,0-0.379-0.947-0.499-1.072
          C9.621,3.209,9.434,3.123,9.182,3.076V2.742h3.84v0.334c-0.301,0.018-0.489,0.065-0.569,0.137
          c-0.08,0.076-0.12,0.182-0.12,0.32c0,0.131,1.291,4.148,1.291,4.148s1.171-3.74,1.171-3.896
          c0-0.234-0.051-0.404-0.153-0.514c-0.101-0.107-0.299-0.172-0.592-0.195V2.742h2.22v0.334
          c-0.245,0.035-0.442,0.133-0.585,0.291c-0.146,0.158-2.662,8.023-2.662,8.023h-0.66V11.391z
          M24.933,4.67c0,0.266-0.131,0.482-0.293,0.482h-7.79c-0.162,0-0.293-0.217-0.293-0.482V3.861
          c0-0.266,0.131-0.482,0.293-0.482h7.79c0.162,0,0.293,0.217,0.293,0.482V4.67z
          M24.997,10.662c0,0.268-0.131,0.48-0.292,0.48h-7.791c-0.164,0-0.293-0.213-0.293-0.48V9.854
          c0-0.266,0.129-0.484,0.293-0.484h7.791c0.161,0,0.292,0.219,0.292,0.484V10.662z
          M24.965,7.676c0,0.268-0.129,0.482-0.293,0.482h-7.79c-0.162,0-0.293-0.215-0.293-0.482
          V6.869c0-0.268,0.131-0.484,0.293-0.484h7.79c0.164,0,0.293,0.217,0.293,0.484V7.676z"
        />
      </g>
    </svg>
    </div>
  </button>

    </div>
  `;
}

export class SourceContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    this.setupSourceContainerStyles();
    this.isAnimating = false;
  }

  setupSourceContainerStyles() {
    const c = this.container;
    if (!c) return;
    Object.assign(c.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      width: "0",
      height: "0",
      overflow: "hidden",
      transition: "width 0.4s ease-out, height 0.4s ease-out",
      zIndex: "1000",
      backgroundColor: "#221F20",
      boxShadow: "0 0 15px rgba(0, 0, 0, 0.2)",
      borderRadius: "1em",
      maxWidth: "400px",
      maxHeight: "400px",
    });
  }

  async openContainer(content = null, highlightId = null) {
    if (this.isAnimating) return;
    this.isAnimating = true;

    // 1) build or accept HTML
    let html = content;
    if (!html) {
      const bookId = window.currentBookId || "default-id";
      html = await buildSourceHtml(bookId);
    }

    // 2) inject into container
    this.container.innerHTML = html;

    // 3) wire download buttons *once*
    const mdBtn = this.container.querySelector("#download-md");
    const docxBtn = this.container.querySelector("#download-docx");
    if (mdBtn) {
      mdBtn.addEventListener("click", async () => {
        // TODO: implement markdown download
        console.log("Download .md clicked");
        exportBookAsMarkdown(book);
        });
    }
    if (docxBtn) {
      docxBtn.addEventListener("click", () => {
        console.log("Download .docx clicked");
        exportBookAsDocxStyled(book);
      });
    }

    // 4) make container visible
    this.container.classList.remove("hidden");
    this.container.style.visibility = "visible";
    this.container.style.display = "block";

    // 5) compute target size
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(vw * 0.8, 600);
    const h = Math.min(vh * 0.9, 800);

    // 6) animate open
    requestAnimationFrame(() => {
      this.container.style.width = `${w}px`;
      this.container.style.height = `${h}px`;

      // freeze background
      this.frozenElements.forEach((el) => this.freezeElement(el));

      // activate overlay
      if (this.overlay) {
        this.overlay.classList.add("active");
        this.overlay.style.display = "block";
        this.overlay.style.opacity = "1";
      }

      // hide nav
      ["nav-buttons", "logoContainer", "topRightContainer"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add("hidden-nav");
      });

      this.isOpen = true;
      if (window.uiState) {
        window.uiState.setActiveContainer(this.container.id);
      } else {
        window.activeContainer = this.container.id;
      }

      this.container.addEventListener(
        "transitionend",
        () => {
          this.isAnimating = false;
          console.log("Source container open animation complete");
        },
        { once: true }
      );
    });
  }

  closeContainer() {
    if (this.isAnimating) return;
    this.isAnimating = true;

    // animate close
    this.container.style.width = "0";
    this.container.style.height = "0";

    // unfreeze background
    this.frozenElements.forEach((el) => this.unfreezeElement(el));

    // hide overlay
    if (this.overlay) {
      this.overlay.classList.remove("active");
      this.overlay.style.display = "none";
      this.overlay.style.opacity = "0";
    }

    // show nav
    ["nav-buttons", "logoContainer", "topRightContainer"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove("hidden-nav");
    });

    this.isOpen = false;
    if (window.uiState) {
      window.uiState.setActiveContainer("main-content");
    } else {
      window.activeContainer = "main-content";
    }

    this.container.addEventListener(
      "transitionend",
      () => {
        this.container.classList.add("hidden");
        this.isAnimating = false;
        console.log("Source container close animation complete");
        if (this.overlay) this.overlay.style.display = "none";
      },
      { once: true }
    );
  }

  toggleContainer() {
    if (this.isAnimating) return;
    this.isOpen ? this.closeContainer() : this.openContainer();
  }
}

// initialize and export
const sourceManager = new SourceContainerManager(
  "source-container",
  "ref-overlay",
  "cloudRef",
  ["main-content"]
);
export default sourceManager;



let _TurndownService = null;
async function loadTurndown() {
  if (_TurndownService) return _TurndownService;
  // Skypack will auto-optimize to an ES module
  const mod = await import('https://cdn.skypack.dev/turndown');
  // turndown’s default export is the constructor
  _TurndownService = mod.default;
  return _TurndownService;
}

let _Docx = null;
async function loadDocxLib() {
  if (_Docx) return _Docx;
  // Skypack serves this as a proper ES module with CORS headers
  const mod = await import('https://cdn.skypack.dev/docx@8.3.0');
  // The module exports Document, Packer, Paragraph, etc.
  _Docx = mod;
  return _Docx;
}

/**
 * Fetches all nodeChunks for a book, converts to markdown,
 * and returns a single string.
 */
async function buildMarkdownForBook(bookId = book || 'latest') {
  // 1) get raw chunks
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  // 2) sort by chunk_id
  chunks.sort((a,b) => a.chunk_id - b.chunk_id);
  // 3) load converter
  const Turndown = await loadTurndown();
  const turndownService = new Turndown();
  // 4) convert each chunk.html (or chunk.content) → md
  const mdParts = chunks.map(chunk =>
    turndownService.turndown(chunk.content || chunk.html)
  );
  // 5) join with double newlines
  return mdParts.join('\n\n');
}

async function buildHtmlForBook(bookId = book || 'latest') {
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a, b) => a.chunk_id - b.chunk_id);
  // assume chunk.content contains valid inner-HTML of each <div>
  const body = chunks.map(c => c.content || c.html).join('\n');
  // wrap in minimal docx‐friendly HTML
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>Book ${bookId}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

async function buildDocxBuffer(bookId = book || 'latest') {
  const { Document, Packer, Paragraph, TextRun } = await loadDocxLib();
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a, b) => a.chunk_id - b.chunk_id);

  // Flatten all HTML → plaintext (you can also parse tags more richly)
  const paragraphs = chunks.map(chunk => {
    const plaintext = htmlToText(chunk.content || chunk.html, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }],
    });
    return new Paragraph({
      children: [new TextRun(plaintext)],
    });
  });

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });

  // Packer.toBlob returns a Blob suitable for download
  return Packer.toBlob(doc);
}

/**
 * Public helper: build + download in one go.
 */
async function exportBookAsMarkdown(bookId = book || 'latest') {
  try {
    const md = await buildMarkdownForBook(bookId);
    const filename = `book-${bookId}.md`;
    downloadMarkdown(filename, md);
    console.log(`✅ Markdown exported to ${filename}`);
  } catch (err) {
    console.error('❌ Failed to export markdown:', err);
  }
}

async function exportBookAsDocx(bookId = book || 'latest') {
  try {
    const blob = await buildDocxBuffer(bookId);
    const filename = `book-${bookId}.docx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log(`✅ DOCX exported to ${filename}`);
  } catch (err) {
    console.error('❌ Failed to export .docx:', err);
  }
}

/**
 * Triggers a download in the browser of the given text as a .md file.
 */
function downloadMarkdown(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

//


// Walk a DOM node and return either Paragraphs or Runs.
// Runs of type TextRun must be created with their styling flags upfront.
function htmlElementToDocx(node) {
  const out = [];

  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      // plain text
      out.push(
        new TextRun({
          text: child.textContent,
        })
      );
    }
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();

      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = {
            h1: HeadingLevel.HEADING_1,
            h2: HeadingLevel.HEADING_2,
            h3: HeadingLevel.HEADING_3,
            h4: HeadingLevel.HEADING_4,
            h5: HeadingLevel.HEADING_5,
            h6: HeadingLevel.HEADING_6,
          }[tag];
          out.push(
            new Paragraph({
              text: child.textContent,
              heading: level,
            })
          );
          break;
        }

        case 'strong':
        case 'b': {
          // Bold: each text node under here becomes a bold run
          child.childNodes.forEach(n => {
            if (n.nodeType === Node.TEXT_NODE) {
              out.push(
                new TextRun({
                  text: n.textContent,
                  bold: true,
                })
              );
            } else {
              // nested tags: recurse and mark bold on each run
              htmlElementToDocx(n).forEach(run => {
                if (run instanceof TextRun) {
                  out.push(
                    new TextRun({
                      text: run.text,
                      bold: true,
                      italics: run.italics,
                    })
                  );
                } else {
                  out.push(run);
                }
              });
            }
          });
          break;
        }

        case 'em':
        case 'i': {
          child.childNodes.forEach(n => {
            if (n.nodeType === Node.TEXT_NODE) {
              out.push(
                new TextRun({
                  text: n.textContent,
                  italics: true,
                })
              );
            } else {
              htmlElementToDocx(n).forEach(run => {
                if (run instanceof TextRun) {
                  out.push(
                    new TextRun({
                      text: run.text,
                      italics: true,
                      bold: run.bold,
                    })
                  );
                } else {
                  out.push(run);
                }
              });
            }
          });
          break;
        }

        case 'a': {
          const url = child.getAttribute('href') || '';
          const text = child.textContent;
          out.push(
            new ExternalHyperlink({
              link: url,
              children: [
                new TextRun({
                  text,
                  style: 'Hyperlink',
                }),
              ],
            })
          );
          break;
        }

        case 'br': {
          out.push(new TextRun({ text: '\n' }));
          break;
        }

        default:
          // everything else: recurse inline
          htmlElementToDocx(child).forEach(item => out.push(item));
      }
    }
  });

  return out;
}

// Build the docx with styled runs/headings/links
async function buildDocxWithStyles(bookId = book || 'latest') {
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a,b) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();
  const children = [];

  for (const chunk of chunks) {
    const frag = parser.parseFromString(
      `<div>${chunk.content||chunk.html}</div>`,
      'text/html'
    ).body.firstChild;

    // collect Runs and Paragraphs
    const runsAndParas = htmlElementToDocx(frag);

    // group Runs into Paragraphs
    let buf = [];
    runsAndParas.forEach(item => {
      if (item instanceof Paragraph) {
        if (buf.length) {
          children.push(new Paragraph({ children: buf }));
          buf = [];
        }
        children.push(item);
      } else {
        buf.push(item);
      }
    });
    if (buf.length) {
      children.push(new Paragraph({ children: buf }));
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Packer.toBlob(doc);
}

async function exportBookAsDocxStyled(bookId = book || 'latest') {
  try {
    const blob = await buildDocxWithStyles(bookId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `book-${bookId}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ Styled DOCX exported');
  } catch (e) {
    console.error('❌ export styled docx failed', e);
  }
}


