/**
 * EnterKeyHandler Module
 *
 * Handles Enter key behavior in the contenteditable editor.
 * - Creates new paragraphs
 * - Handles special cases for headings, blockquotes, and pre elements
 * - Triple-enter to exit blockquotes/pre elements
 * - Shift+Enter for line breaks within paragraphs
 */

import { chunkOverflowInProgress } from "../utilities/operationState.js";
import { book } from '../app.js';
import { generateIdBetween, setElementIds, ensureNodeHasValidId, findPreviousElementId, findNextElementId } from "../utilities/IDfunctions.js";
import { queueNodeForSave } from './index.js';
import { verbose } from '../utilities/logger.js';

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
 * Uses .reader-content-wrapper as the scroll container (not window)
 */
function scrollCaretIntoView() {
  verbose.content("scrollCaretIntoView start", 'divEditor/enterKeyHandler.js');
  const sel = document.getSelection();
  if (!sel.rangeCount) {
    verbose.content("no selection range → abort", 'divEditor/enterKeyHandler.js');
    return;
  }

  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();

  // If caret rect has no height (empty paragraph with <br>), use parent element's rect
  if (!rect || rect.height === 0) {
    const node = range.startContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (element) {
      rect = element.getBoundingClientRect();
      verbose.content(`caret rect was empty, using parent element rect`, 'divEditor/enterKeyHandler.js');
    }
  }

  if (!rect || rect.height === 0) {
    verbose.content("no valid rect found → abort", 'divEditor/enterKeyHandler.js');
    return;
  }

  verbose.content(`caret rect: top=${Math.round(rect.top)} bottom=${Math.round(rect.bottom)} height=${Math.round(rect.height)}`, 'divEditor/enterKeyHandler.js');

  // Find the scroll container (not window)
  const scrollContainer = document.querySelector('.reader-content-wrapper');
  if (!scrollContainer) {
    verbose.content("no scroll container found", 'divEditor/enterKeyHandler.js');
    return;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const clipBottom = 40; // clip-path: inset(15px 0 40px 0) clips 40px from bottom
  const clipTop = 15;    // clip-path clips 15px from top
  const padding = 20;    // Extra buffer space

  // Visible area is smaller than containerRect due to clip-path
  const visibleBottom = containerRect.bottom - clipBottom;
  const visibleTop = containerRect.top + clipTop;

  // Check if caret is below visible area
  if (rect.bottom > visibleBottom - padding) {
    const delta = rect.bottom - (visibleBottom - padding);
    verbose.content(`scrolling container down by ${delta}px`, 'divEditor/enterKeyHandler.js');
    scrollContainer.scrollBy({ top: delta, behavior: "smooth" });
  }
  // Check if caret is above visible area
  else if (rect.top < visibleTop + padding) {
    const delta = rect.top - (visibleTop + padding);
    verbose.content(`scrolling container up by ${delta}px`, 'divEditor/enterKeyHandler.js');
    scrollContainer.scrollBy({ top: delta, behavior: "smooth" });
  } else {
    verbose.content("caret in view, no scroll", 'divEditor/enterKeyHandler.js');
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
  // Delay scroll to ensure DOM has settled
  setTimeout(scrollCaretIntoView, 50);
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

  // Check if renumbering was flagged during ID generation
  if (window.__pendingRenumbering) {
    console.log('🔄 Renumbering flagged - queueing new element and triggering renumbering');

    // Immediately queue this new element for saving
    queueNodeForSave(newParagraph.id, 'add');

    // Import and trigger renumbering
    import('../utilities/IDfunctions.js').then(({ triggerRenumberingWithModal }) => {
      triggerRenumberingWithModal(0).catch(err => {
        console.error('Background renumbering failed:', err);
      });
    });

    // Clear the flag
    window.__pendingRenumbering = false;
  }

  verbose.content(`Created new paragraph with ID ${newParagraph.id} after ${blockElement.id}`, 'divEditor/enterKeyHandler.js');

  // 6. Move cursor and scroll
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  moveCaretTo(target, 0);

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
    verbose.content("EnterKeyHandler initialized", 'divEditor/enterKeyHandler.js');
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

    verbose.content(`Enter count: ${this.enterCount}`, 'divEditor/enterKeyHandler.js');

    if (window.isEditing) {
      // Get the current selection
      const selection = document.getSelection();
      if (selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);

      // 🎯 SUP TAG ESCAPE: Prevent Enter inside any <sup> element
      // Sup tags contain generated content (footnote numbers, hypercite arrows) - never user-editable
      let checkElement = range.startContainer;
      const startOffset = range.startOffset;
      let supElement = null;
      let cursorIsInsideSup = false;

      // Check if inside a sup
      if (checkElement.nodeType === Node.TEXT_NODE) {
        supElement = checkElement.parentElement?.closest('sup');
        if (supElement) {
          cursorIsInsideSup = true;
        }
        // Note: don't detect empty text node before sup - let enter work normally there
      } else {
        supElement = checkElement?.closest('sup');
        if (supElement) {
          cursorIsInsideSup = true;
        }
        // Note: don't detect "before sup" case - let enter work normally there
      }

      if (supElement && cursorIsInsideSup) {
        event.preventDefault();

        const offset = range.startOffset;
        const supTextLength = supElement.textContent?.length || 0;
        const atStart = offset === 0;

        const parent = supElement.parentNode;
        if (!parent) {
          this.enterCount = 0;
          return;
        }

        const newRange = document.createRange();

        // If at start (before content), move cursor BEFORE sup; otherwise move AFTER
        if (atStart) {
          newRange.setStartBefore(supElement);
        } else {
          // Create zero-width space after the sup if needed
          let nextNode = supElement.nextSibling;
          if (!nextNode || nextNode.nodeType !== Node.TEXT_NODE) {
            nextNode = document.createTextNode('\u200B');
            parent.insertBefore(nextNode, supElement.nextSibling);
          }
          newRange.setStart(nextNode, 0);
        }

        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);

        this.enterCount = 0;
        return;
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
          verbose.content("Shift+Enter in <p>: Inserting <br>", 'divEditor/enterKeyHandler.js');
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
        verbose.content("Enter in <p>: Creating new paragraph", 'divEditor/enterKeyHandler.js');

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

          // ✅ FIX: Queue the modified original paragraph for save
          // extractContents() modifies blockElement but MutationObserver filters out
          // text-node-only mutations, so we must explicitly save
          queueNodeForSave(blockElement.id, 'update');

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
        }

        return;
      }

      // SECTION 2.5: Handle list items (LI)
      if (blockElement.tagName === "LI") {
        event.preventDefault();

        // Find the parent list (UL or OL)
        const parentList = blockElement.closest("ul, ol");
        if (!parentList) {
          console.error("LI element has no parent list");
          return;
        }

        // Ensure parent list has a valid ID
        ensureNodeHasValidId(parentList);
        if (!parentList.id) {
          console.error("Could not assign ID to parent list. Aborting.");
          return;
        }

        // Check if this is an empty LI (exit list behavior)
        const isEmpty = blockElement.textContent.trim() === "" ||
                        blockElement.innerHTML === "<br>";

        if (isEmpty) {
          // Get position of this LI in the list
          const allItems = Array.from(parentList.children);
          const itemIndex = allItems.indexOf(blockElement);
          const itemsBefore = allItems.slice(0, itemIndex);
          const itemsAfter = allItems.slice(itemIndex + 1);

          // Remove the empty LI
          blockElement.remove();

          // Create the new paragraph
          const newParagraph = document.createElement('p');
          newParagraph.innerHTML = '<br>';

          if (parentList.children.length === 0) {
            // List is now empty - replace it entirely
            setElementIds(newParagraph, findPreviousElementId(parentList), findNextElementId(parentList), book);
            parentList.replaceWith(newParagraph);
            moveCaretTo(newParagraph, 0);
            queueNodeForSave(newParagraph.id, 'add');
          } else if (itemsBefore.length === 0) {
            // Was first item - put paragraph before list
            setElementIds(newParagraph, findPreviousElementId(parentList), parentList.id, book);
            parentList.before(newParagraph);
            moveCaretTo(newParagraph, 0);
            queueNodeForSave(newParagraph.id, 'add');
            queueNodeForSave(parentList.id, 'update');
          } else if (itemsAfter.length === 0) {
            // Was last item - put paragraph after list
            setElementIds(newParagraph, parentList.id, findNextElementId(parentList), book);
            parentList.after(newParagraph);
            moveCaretTo(newParagraph, 0);
            queueNodeForSave(parentList.id, 'update');
            queueNodeForSave(newParagraph.id, 'add');
          } else {
            // Was in the middle - split the list!
            // 1. Create a new list for items after
            const newList = document.createElement(parentList.tagName);

            // 2. Move items after to the new list
            itemsAfter.forEach(item => newList.appendChild(item));

            // 3. Insert paragraph after original list
            setElementIds(newParagraph, parentList.id, null, book);
            parentList.after(newParagraph);

            // 4. Insert new list after paragraph
            setElementIds(newList, newParagraph.id, findNextElementId(newParagraph), book);
            newParagraph.after(newList);

            moveCaretTo(newParagraph, 0);
            queueNodeForSave(parentList.id, 'update');
            queueNodeForSave(newParagraph.id, 'add');
            queueNodeForSave(newList.id, 'add');
          }
        } else {
          // Non-empty LI: Create new LI after current one
          const newLI = document.createElement('li');

          // Check if cursor is at the end of the text content
          let liIsAtEnd = false;
          if (range.startContainer.nodeType === Node.TEXT_NODE) {
            const textLength = range.startContainer.textContent.length;
            liIsAtEnd = range.startOffset === textLength;
            // Also check if we're at the last text node
            if (liIsAtEnd) {
              let node = range.startContainer;
              while (node.nextSibling) {
                if (node.nextSibling.nodeType === Node.TEXT_NODE && node.nextSibling.textContent.trim() !== '') {
                  liIsAtEnd = false;
                  break;
                }
                if (node.nextSibling.nodeType === Node.ELEMENT_NODE && node.nextSibling.textContent.trim() !== '') {
                  liIsAtEnd = false;
                  break;
                }
                node = node.nextSibling;
              }
            }
          } else if (range.startContainer === blockElement) {
            liIsAtEnd = range.startOffset === blockElement.childNodes.length;
          }

          if (liIsAtEnd) {
            // Cursor at end: new empty LI
            newLI.innerHTML = '<br>';
            blockElement.after(newLI);
          } else {
            // Cursor in middle: split content
            const rangeToEnd = document.createRange();
            rangeToEnd.setStart(range.startContainer, range.startOffset);
            rangeToEnd.setEndAfter(blockElement.lastChild || blockElement);
            const extractedContent = rangeToEnd.extractContents();

            newLI.appendChild(extractedContent);
            if (newLI.innerHTML.trim() === '' || newLI.textContent.trim() === '') {
              newLI.innerHTML = '<br>';
            }
            if (blockElement.innerHTML.trim() === '' || blockElement.textContent.trim() === '') {
              blockElement.innerHTML = '<br>';
            }

            blockElement.after(newLI);
          }

          moveCaretTo(newLI, 0);
          queueNodeForSave(parentList.id, 'update');
        }

        this.enterCount = 0;
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

      // 🔧 FIX: For headings, strip heading tags but preserve inline elements (sup, a, em, strong, etc.)
      // Prevents invalid HTML like <p><h1>text</h1></p>
      if (isHeading && content) {
        const tempDiv = document.createElement("div");
        tempDiv.appendChild(content);
        // Remove any nested heading tags but keep other content
        const nestedHeadings = tempDiv.querySelectorAll("h1, h2, h3, h4, h5, h6");
        nestedHeadings.forEach((h) => {
          // Replace heading with its children
          while (h.firstChild) {
            h.parentNode.insertBefore(h.firstChild, h);
          }
          h.remove();
        });
        // Create document fragment with the cleaned content
        const fragment = document.createDocumentFragment();
        while (tempDiv.firstChild) {
          fragment.appendChild(tempDiv.firstChild);
        }
        content = fragment.childNodes.length > 0 ? fragment : null;
      }

      // Create and insert new paragraph
      const newParagraph = createAndInsertParagraph(
        blockElement,
        chunkContainer,
        content,
        selection
      );

      this.enterCount = 0;
    }
  }

  // Cleanup method
  destroy() {
    document.removeEventListener("keydown", this.handleKeyDown);
    verbose.content("EnterKeyHandler destroyed", 'divEditor/enterKeyHandler.js');
  }
}
