/**
 * EnterKeyHandler Module
 *
 * Handles Enter key behavior in the contenteditable editor.
 * - Creates new paragraphs
 * - Handles special cases for headings, blockquotes, and pre elements
 * - Triple-enter to exit blockquotes/pre elements
 * - Shift+Enter for line breaks within paragraphs
 */

import { chunkOverflowInProgress } from '../operationState.js';
import { book } from '../app.js';
import { generateIdBetween, setElementIds, ensureNodeHasValidId } from '../IDfunctions.js';
import { queueNodeForSave } from '../divEditor.js';

/**
 * Helper: Check if element is in viewport
 */
function isElementInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

/**
 * Helper: Scroll caret into view
 */
function scrollCaretIntoView() {
  console.log("→ scrollCaretIntoView start");
  const sel = document.getSelection();
  if (!sel.rangeCount) {
    console.log("  no selection range → abort");
    return;
  }

  const range = sel.getRangeAt(0);
  const clientRects = range.getClientRects();
  const rect = clientRects.length
    ? clientRects[0]
    : range.getBoundingClientRect();

  console.log(
    "  caret rect:",
    `top=${Math.round(rect.top)}`,
    `bottom=${Math.round(rect.bottom)}`,
    `height=${Math.round(rect.height)}`
  );

  const padding = 20;
  const vh = window.innerHeight || document.documentElement.clientHeight;

  if (rect.height > 0) {
    // Normal: scroll to keep caret visible
    if (rect.bottom > vh - padding) {
      const delta = rect.bottom - (vh - padding);
      console.log(`  scrolling down by ${delta}px`);
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else if (rect.top < padding) {
      const delta = rect.top - padding;
      console.log(`  scrolling up by ${delta}px`);
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      console.log("  caret in view, no scroll");
    }
  }
}

/**
 * Helper: Move the caret to (node, offset), then scroll it into view
 */
function moveCaretTo(node, offset = 0) {
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  scrollCaretIntoView();
}

/**
 * Helper: Create and insert a new paragraph after blockElement
 */
function createAndInsertParagraph(blockElement, chunkContainer, content, selection) {
  // 1. PROACTIVELY FIX THE SOURCE ELEMENT
  ensureNodeHasValidId(blockElement);
  if (!blockElement.id) {
    console.error("FATAL: Could not assign an ID to the source block element. Aborting paragraph creation.", blockElement);
    return null;
  }

  // 2. Create the new paragraph
  const newParagraph = document.createElement('p');

  // 3. Handle content
  if (content) {
    const nodes = content.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? Array.from(content.childNodes)
      : [content];

    nodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'P') {
        Array.from(node.childNodes).forEach(child => {
          newParagraph.appendChild(child.cloneNode(true));
        });
      } else {
        newParagraph.appendChild(node.cloneNode(true));
      }
    });
  } else {
    const br = document.createElement('br');
    newParagraph.appendChild(br);
  }

  // 4. SIMPLIFIED AND UNIFIED ID GENERATION
  const container = blockElement.closest('.chunk') || blockElement.parentNode;

  // Find the next element with a numeric ID
  let nextElement = blockElement.nextElementSibling;
  while (nextElement && (!nextElement.id || !/^\d+(\.\d+)?$/.test(nextElement.id))) {
    nextElement = nextElement.nextElementSibling;
  }

  // ALWAYS use setElementIds to set both id and data-node-id
  const nextElementId = nextElement ? nextElement.id : null;
  setElementIds(newParagraph, blockElement.id, nextElementId, book);

  // 5. Insert the paragraph at the correct position in the DOM
  if (blockElement.nextSibling) {
    container.insertBefore(newParagraph, blockElement.nextSibling);
  } else {
    container.appendChild(newParagraph);
  }

  console.log(`Created new paragraph with ID ${newParagraph.id} after ${blockElement.id}`);

  // Check if renumbering was flagged during ID generation
  if (window.__pendingRenumbering) {
    console.log('🔄 Renumbering flagged - queueing new element and triggering renumbering');

    // Immediately queue this new element for saving
    queueNodeForSave(newParagraph.id, 'add');

    // Import and trigger renumbering
    import('../IDfunctions.js').then(({ triggerRenumberingWithModal }) => {
      triggerRenumberingWithModal(0).catch(err => {
        console.error('Background renumbering failed:', err);
      });
    });

    // Clear the flag
    window.__pendingRenumbering = false;
  }

  // 6. Move cursor and scroll
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  moveCaretTo(target, 0);
  setTimeout(() => {
    newParagraph.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, 10);

  return newParagraph;
}

/**
 * EnterKeyHandler class
 * Manages Enter key behavior for creating paragraphs, handling headings,
 * blockquotes, and pre elements
 */
export class EnterKeyHandler {
  constructor() {
    // State is now instance-specific, not global
    this.lastKeyWasEnter = false;
    this.enterCount = 0;
    this.lastEnterTime = 0;

    // Bind the event handler to this instance
    this.handleKeyDown = this.handleKeyDown.bind(this);

    // Attach the listener
    document.addEventListener("keydown", this.handleKeyDown);
    console.log("✅ EnterKeyHandler initialized.");
  }

  handleKeyDown(event) {
    if (event.key === "Enter" && chunkOverflowInProgress) {
      event.preventDefault();
      console.log("Enter key ignored during chunk overflow processing");
      return;
    }

    if (event.key !== "Enter") {
      this.lastKeyWasEnter = false;
      this.enterCount = 0;
      return;
    }

    const now = Date.now();
    if (this.lastKeyWasEnter && now - this.lastEnterTime < 2000) {
      this.enterCount++;
    } else {
      this.enterCount = 1;
    }

    this.lastKeyWasEnter = true;
    this.lastEnterTime = now;

    console.log("Enter count:", this.enterCount);

    if (window.isEditing) {
      // Get the current selection
      const selection = document.getSelection();
      if (selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);

      // 🔥 FIX: Prevent <br> insertion inside hypercite <sup> elements
      let checkElement = range.startContainer;
      if (checkElement.nodeType === Node.TEXT_NODE) {
        checkElement = checkElement.parentElement;
      }

      // Walk up the DOM tree to find if we're inside a <sup class="open-icon">
      const openIconSup = checkElement.closest('sup.open-icon');
      if (openIconSup) {
        console.log('🎯 Cursor is inside <sup class="open-icon">, moving outside before Enter');

        // Find the parent <a> element
        const hyperciteLink = openIconSup.closest('a[id^="hypercite_"]');
        if (hyperciteLink) {
          event.preventDefault();

          // Create text node to position cursor after the link
          const zwsp = document.createTextNode('\u200B');
          hyperciteLink.parentNode.insertBefore(zwsp, hyperciteLink.nextSibling);

          // Position cursor after the hypercite link
          const newRange = document.createRange();
          newRange.setStart(zwsp, 1);
          newRange.collapse(true);

          selection.removeAllRanges();
          selection.addRange(newRange);

          // Insert the line break
          const br = document.createElement('br');
          newRange.insertNode(br);

          // Position cursor after the br
          const finalRange = document.createRange();
          finalRange.setStartAfter(br);
          finalRange.collapse(true);

          selection.removeAllRanges();
          selection.addRange(finalRange);

          console.log('✅ Cursor moved outside hypercite link and line break inserted');

          this.enterCount = 0;
          return;
        }
      }

      let currentNode = range.startContainer;
      if (currentNode.nodeType !== Node.ELEMENT_NODE) {
        currentNode = currentNode.parentElement;
      }
      let blockElement = currentNode;
      while (
        blockElement &&
        ![
          "P",
          "DIV",
          "H1",
          "H2",
          "H3",
          "H4",
          "H5",
          "H6",
          "LI",
          "BLOCKQUOTE",
          "PRE",
        ].includes(blockElement.tagName)
      ) {
        blockElement = blockElement.parentElement;
      }
      if (!blockElement) return;
      const chunkContainer = blockElement.closest(".chunk");
      if (!chunkContainer) return;
      const isHeading = /^H[1-6]$/.test(blockElement.tagName);
      let isAtStart = false;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        isAtStart =
          range.startOffset === 0 &&
          (range.startContainer === blockElement.firstChild ||
            range.startContainer.parentNode === blockElement.firstChild);
      } else if (range.startContainer === blockElement) {
        isAtStart = range.startOffset === 0;
      }

      if (isHeading && isAtStart) {
        event.preventDefault();

        // PROACTIVELY FIX THE HEADING'S ID
        ensureNodeHasValidId(blockElement);
        if (!blockElement.id) {
          console.error(
            "Could not assign ID to heading. Aborting.",
            blockElement
          );
          return;
        }

        // 1. Create a new paragraph to insert BEFORE the heading
        const newParagraph = document.createElement("p");
        newParagraph.innerHTML = "<br>";

        // 2. Generate ID for the new paragraph
        if (blockElement.id) {
          // Find previous element with numeric ID
          let prevElement = blockElement.previousElementSibling;
          while (
            prevElement &&
            (!prevElement.id || !/^\d+(\.\d+)?$/.test(prevElement.id))
          ) {
            prevElement = prevElement.previousElementSibling;
          }

          // Special case: if heading is ID "1" and no previous element, use "0" as beforeId
          if (!prevElement && blockElement.id === "1") {
            setElementIds(newParagraph, "0", "1", book);
          } else if (prevElement && prevElement.id) {
            // Generate ID between previous and current
            setElementIds(newParagraph, prevElement.id, blockElement.id, book);
          } else {
            // Generate ID before current
            setElementIds(newParagraph, null, blockElement.id, book);
          }

          // 3. Insert the new paragraph before the heading
          blockElement.parentNode.insertBefore(newParagraph, blockElement);

          // 4. Save the current scroll position
          const scrollYBefore = window.scrollY;

          // 5. Ensure the heading stays visible by restoring scroll position
          setTimeout(() => {
            window.scrollTo(0, scrollYBefore);

            if (!isElementInViewport(blockElement)) {
              blockElement.scrollIntoView({
                behavior: "auto",
                block: "nearest",
              });
            }
          }, 0);
        }

        this.enterCount = 0;
        return;
      }

      // SECTION 1: Special handling for paragraph elements
      if (blockElement.tagName === "P") {
        event.preventDefault();

        // PATH A: User wants a line break (Shift+Enter)
        if (event.shiftKey) {
          console.log("Shift+Enter in <p>: Inserting <br>");
          const br = document.createElement("br");
          range.insertNode(br);

          // Force cursor after the br by inserting a zero-width space
          const zwsp = document.createTextNode("\u200B");
          br.parentNode.insertBefore(zwsp, br.nextSibling);

          // Position cursor in the zero-width space
          const newRange = document.createRange();
          newRange.setStart(zwsp, 1);
          newRange.collapse(true);

          selection.removeAllRanges();
          selection.addRange(newRange);

          this.enterCount = 0;
          return;
        }

        // PATH B: User wants a new paragraph (Regular Enter)
        console.log("Enter in <p>: Creating new paragraph");

        // Split the content at cursor position
        const cursorOffset = range.startOffset;

        // Check if cursor is at the end of the text content
        let isAtEnd = false;
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          isAtEnd = cursorOffset === range.startContainer.textContent.length;
        } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
          isAtEnd = cursorOffset === range.startContainer.childNodes.length;
        }

        // Prepare content for the new paragraph
        let content = null;
        if (
          !(
            (isAtEnd && range.startContainer === blockElement.lastChild) ||
            (range.startContainer === blockElement &&
              blockElement.textContent.trim() === "")
          )
        ) {
          const rangeToExtract = document.createRange();
          rangeToExtract.setStart(range.startContainer, cursorOffset);
          rangeToExtract.setEndAfter(blockElement);

          const clonedContent = rangeToExtract.cloneContents();
          const tempDiv = document.createElement("div");
          tempDiv.appendChild(clonedContent);
          const extractedText = tempDiv.textContent.trim();

          // Store the content to move to the new paragraph
          content = rangeToExtract.extractContents();

          // If the current block is now empty, add a <br>
          if (
            blockElement.innerHTML === "" ||
            blockElement.textContent.trim() === ""
          ) {
            blockElement.innerHTML = "<br>";
          }

          if (extractedText === "") {
            content = null;
          }
        }

        // Create and insert new paragraph
        const newParagraph = createAndInsertParagraph(
          blockElement,
          chunkContainer,
          content,
          selection
        );

        // Scroll the new paragraph into view
        setTimeout(() => {
          newParagraph.scrollIntoView({
            behavior: "auto",
            block: "nearest",
          });
        }, 10);

        this.enterCount = 0;
        return;
      }

      // SECTION 2: Handle blockquote and pre (code blocks)
      if (
        blockElement.tagName === "BLOCKQUOTE" ||
        blockElement.tagName === "PRE"
      ) {
        event.preventDefault();

        // Triple Enter to exit block
        if (this.enterCount >= 3) {
          const rangeToEnd = document.createRange();
          rangeToEnd.setStart(range.endContainer, range.endOffset);
          rangeToEnd.setEndAfter(blockElement);
          const contentAfterCursor = rangeToEnd.cloneContents();
          const isEffectivelyAtEnd =
            contentAfterCursor.textContent.replace(/\u200B/g, "").trim() === "";

          // PATH A: Exit from end
          if (isEffectivelyAtEnd) {
            console.log("Exiting block from the end.");
            let targetElement = blockElement;
            if (
              blockElement.tagName === "PRE" &&
              blockElement.querySelector("code")
            ) {
              targetElement = blockElement.querySelector("code");
            }

            // Clean up trailing <br>s and whitespace
            while (targetElement.lastChild) {
              const last = targetElement.lastChild;
              if (last.nodeName === "BR") {
                targetElement.removeChild(last);
              } else if (
                last.nodeType === Node.TEXT_NODE &&
                last.textContent.replace(/\u200B/g, "").trim() === ""
              ) {
                targetElement.removeChild(last);
              } else {
                break;
              }
            }

            if (targetElement.innerHTML.trim() === "") {
              targetElement.innerHTML = "<br>";
            }
            if (blockElement.id) {
              queueNodeForSave(blockElement.id, "update");
            }
            const newParagraph = createAndInsertParagraph(
              blockElement,
              chunkContainer,
              null,
              selection
            );
            setTimeout(() => {
              newParagraph.scrollIntoView({ behavior: "auto", block: "nearest" });
            }, 10);
          } else {
            // PATH B: Split block from middle
            console.log("Splitting block from the middle.");

            // Extract content from cursor to end
            const contentToMove = rangeToEnd.extractContents();

            // Clean up first block
            let firstBlockTarget = blockElement;
            if (
              blockElement.tagName === "PRE" &&
              blockElement.querySelector("code")
            ) {
              firstBlockTarget = blockElement.querySelector("code");
            }

            // Robustly clean up trailing <br>s and whitespace
            while (firstBlockTarget.lastChild) {
              const last = firstBlockTarget.lastChild;
              if (last.nodeName === "BR") {
                firstBlockTarget.removeChild(last);
              } else if (
                last.nodeType === Node.TEXT_NODE &&
                last.textContent.replace(/\u200B/g, "").trim() === ""
              ) {
                firstBlockTarget.removeChild(last);
              } else {
                break;
              }
            }
            if (firstBlockTarget.innerHTML.trim() === "") {
              firstBlockTarget.innerHTML = "<br>";
            }
            if (blockElement.id) {
              queueNodeForSave(blockElement.id, "update");
            }

            // Create new paragraph and new block for split content
            const newParagraph = document.createElement("p");
            newParagraph.innerHTML = "<br>";
            const newSplitBlock = document.createElement(blockElement.tagName);

            // Populate the new block
            let targetForMovedContent = newSplitBlock;
            if (newSplitBlock.tagName === "PRE") {
              const newCode = document.createElement("code");
              newSplitBlock.appendChild(newCode);
              targetForMovedContent = newCode;
            }
            let sourceOfNodes = contentToMove;
            const wrapperNode = contentToMove.querySelector("blockquote, pre");
            if (wrapperNode) {
              if (wrapperNode.tagName === "PRE") {
                sourceOfNodes = wrapperNode.querySelector("code") || wrapperNode;
              } else {
                sourceOfNodes = wrapperNode;
              }
            }
            Array.from(sourceOfNodes.childNodes).forEach((child) => {
              targetForMovedContent.appendChild(child);
            });

            // Clean up leading junk from new block
            while (targetForMovedContent.firstChild) {
              const first = targetForMovedContent.firstChild;

              if (first.nodeName === "BR") {
                targetForMovedContent.removeChild(first);
                continue;
              }

              if (first.nodeType === Node.TEXT_NODE) {
                if (first.nodeValue.replace(/\u200B/g, "").trim() === "") {
                  targetForMovedContent.removeChild(first);
                  continue;
                } else {
                  first.nodeValue = first.nodeValue.replace(/^\s+/, "");
                  break;
                }
              }

              break;
            }

            // Generate IDs and insert into DOM
            const nextSibling = blockElement.nextElementSibling;
            const nextSiblingId = nextSibling ? nextSibling.id : null;
            setElementIds(newParagraph, blockElement.id, nextSiblingId, book);
            setElementIds(newSplitBlock, newParagraph.id, nextSiblingId, book);
            blockElement.after(newParagraph, newSplitBlock);

            // Save new elements and position cursor
            queueNodeForSave(newParagraph.id, "create");
            queueNodeForSave(newSplitBlock.id, "create");
            moveCaretTo(newParagraph, 0);
            newParagraph.scrollIntoView({ behavior: "auto", block: "center" });
          }

          this.enterCount = 0;
        } else {
          // First/second Enter: insert <br>
          let insertTarget = blockElement;

          if (blockElement.tagName === "PRE") {
            const codeElement = blockElement.querySelector("code");
            if (codeElement) {
              insertTarget = codeElement;
            }
          }

          const br = document.createElement("br");
          range.insertNode(br);
          const textNode = document.createTextNode("\u200B");
          range.setStartAfter(br);
          range.insertNode(textNode);
          moveCaretTo(textNode, 0);
          blockElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }

        return;
      }

      // SECTION 3: Handle all other elements (headings, etc.)
      event.preventDefault();

      // Split the content at cursor position
      const cursorOffset = range.startOffset;

      // Check if cursor is at the end
      let isAtEnd = false;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        isAtEnd = cursorOffset === range.startContainer.length;
      } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
        isAtEnd = cursorOffset === range.startContainer.childNodes.length;
      }

      // Prepare content for the new paragraph
      let content = null;
      if (
        !(
          (isAtEnd && range.startContainer === blockElement.lastChild) ||
          (range.startContainer === blockElement &&
            blockElement.textContent.trim() === "")
        )
      ) {
        const rangeToExtract = document.createRange();
        rangeToExtract.setStart(range.startContainer, cursorOffset);
        rangeToExtract.setEndAfter(blockElement);

        const clonedContent = rangeToExtract.cloneContents();
        const tempDiv = document.createElement("div");
        tempDiv.appendChild(clonedContent);
        const extractedText = tempDiv.textContent.trim();

        content = rangeToExtract.extractContents();

        if (
          blockElement.innerHTML === "" ||
          blockElement.textContent.trim() === ""
        ) {
          blockElement.innerHTML = "<br>";
        }

        if (extractedText === "") {
          content = null;
        }
      }
      console.log("blockElement:", blockElement);

      // Create and insert new paragraph
      const newParagraph = createAndInsertParagraph(
        blockElement,
        chunkContainer,
        content,
        selection
      );

      // Scroll after a delay
      setTimeout(() => {
        newParagraph.scrollIntoView({
          behavior: "auto",
          block: "nearest",
        });
      }, 10);

      this.enterCount = 0;
    }
  }

  // Cleanup method
  destroy() {
    document.removeEventListener("keydown", this.handleKeyDown);
    console.log("🧹 EnterKeyHandler destroyed.");
  }
}
