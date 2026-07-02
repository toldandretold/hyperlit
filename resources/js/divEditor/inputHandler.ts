// Extracted from divEditor/index.ts's startObserving — the text-input pipeline. Typing is
// handled via a debounced `input` handler (not the characterData observer) to cut mutation
// churn ~80%. An eager wrapper captures the node id BEFORE the 200ms debounce fires (the
// selection may move away — e.g. an overlay click — within the window), and mobile IME
// composition is paused/resumed around compositionstart/end.
//
// The cohesive state (isComposing / lastInputNodeId / the parent-lookup cache / the debounce
// handle) now lives in this factory's closure instead of floating at module scope. destroy()
// removes the REAL listener references — the old inline teardown removed compositionstart/end
// with fresh empty arrow fns that never matched, leaking those listeners across sessions.
import { debounce } from '../utilities/debounce';
import { queueNodeForSave } from './editorState';
import { verbose } from '../utilities/logger';
import { NUMERICAL_ID_PATTERN, type LineId } from '../utilities/idHelpers';
import { BLOCK_ELEMENT_SELECTOR } from '../utilities/blockElements';
import { stripInlineStylePreservingIntensity } from '../utilities/stripInlineStyle';
import { checkAndInvalidateTocCache } from '../components/tocContainer/index';
import type { SaveQueue } from './saveQueue';

interface InputHandlerOptions {
  editableDiv: HTMLElement;
  /** Read live — a new edit session swaps the SaveQueue instance. */
  getSaveQueue: () => SaveQueue | null;
}

export interface InputHandler {
  /** Force the 200ms debounce to run now (capture recent typing before close/unload). */
  flush(): void;
  /** Flush, then detach all three listeners from the editable div. */
  destroy(): void;
}

export function createInputHandler({ editableDiv, getSaveQueue }: InputHandlerOptions): InputHandler {
  let isComposing = false; // Track mobile IME composition state
  // 🛡️ SAFETY NET: last input node ID so flush can save even when the selection moves
  // (e.g., user clicks an overlay to close within the 200ms debounce window).
  let lastInputNodeId: LineId | null = null;
  // 🚀 PERFORMANCE: cache for input handler parent lookups (50-90% faster on repeat keystrokes).
  const elementToNumericalParent = new WeakMap();

  // 🚀 PERFORMANCE: debounced input handler — replaces the characterData observer.
  const debouncedInputHandler = debounce((e: any) => {
    if (!(window as any).isEditing || isComposing) {
      return; // Skip during mobile IME composition
    }

    // Get the actual element where the cursor is, not e.target (which is always the contenteditable container)
    const selection: any = window.getSelection();
    if (!selection || !selection.rangeCount) {
      // 🛡️ Selection gone (e.g., user clicked overlay during debounce) — use cached node ID
      if (lastInputNodeId) {
        queueNodeForSave(lastInputNodeId, 'update');
      }
      return;
    }

    let targetElement = selection.getRangeAt(0).startContainer;

    // If it's a text node, get its parent element
    if (targetElement.nodeType === Node.TEXT_NODE) {
      targetElement = targetElement.parentElement;
    }

    if (!targetElement) {
      return;
    }

    // 🚀 PERFORMANCE: Check cache first (50-90% faster on repeat keystrokes)
    let parentWithId = elementToNumericalParent.get(targetElement);

    if (!parentWithId) {
      // Cache miss - do expensive lookup
      parentWithId = targetElement.closest('[id]');

      while (parentWithId && !NUMERICAL_ID_PATTERN.test(parentWithId.id)) {
        parentWithId = parentWithId.parentElement?.closest('[id]');
      }

      // Cache the result for future lookups
      if (parentWithId) {
        elementToNumericalParent.set(targetElement, parentWithId);
      }
    }

    if (parentWithId?.id) {
      lastInputNodeId = parentWithId.id;
      // Strip browser-injected inline style attributes (e.g. font-family from execCommand)
      // Keeps the live DOM clean — batch.js already strips on save, this fixes it sooner.
      // Preserve the *-intensity custom properties (hyperlight/hypercite opacity) so marks
      // don't go invisible mid-edit — same as batch.js, so DOM and IndexedDB stay in sync.
      parentWithId.querySelectorAll('[style]').forEach((el: any) => {
        if (!el.matches(BLOCK_ELEMENT_SELECTOR + ', li')) {
          stripInlineStylePreservingIntensity(el);
        }
      });
      queueNodeForSave(parentWithId.id, 'update');
      checkAndInvalidateTocCache(parentWithId.id, parentWithId);
    } else {
      // 🛡️ Selection moved away from contenteditable (e.g., to overlay) — use cached node ID
      if (lastInputNodeId) {
        queueNodeForSave(lastInputNodeId, 'update');
        checkAndInvalidateTocCache(lastInputNodeId, document.getElementById(lastInputNodeId));
      }
    }
  }, 200); // 🚀 Reduced from 300ms to 200ms for snappier feel

  // 🛡️ Wrap input event to eagerly capture node ID before debounce
  // Selection may move by the time the 200ms debounce fires (e.g., overlay click)
  const onInput = (e: any) => {
    if ((window as any).isEditing && !isComposing) {
      const saveQueue = getSaveQueue();
      if (saveQueue) saveQueue.recordInputEvent();
      const sel: any = window.getSelection();
      if (sel?.rangeCount) {
        let el = sel.getRangeAt(0).startContainer;
        if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
        if (el) {
          let parent = elementToNumericalParent.get(el);
          if (!parent) {
            parent = el.closest('[id]');
            while (parent && !NUMERICAL_ID_PATTERN.test(parent.id)) {
              parent = parent.parentElement?.closest('[id]');
            }
            if (parent) elementToNumericalParent.set(el, parent);
          }
          if (parent?.id) lastInputNodeId = parent.id;
        }
      }
    }
    debouncedInputHandler(e);
  };

  // 🚀 MOBILE: Handle IME composition events (autocorrect, predictive text)
  const onCompositionStart = () => {
    isComposing = true;
    verbose.content('IME composition started - pausing input processing', 'divEditor/index.js');
  };

  const onCompositionEnd = (e: any) => {
    isComposing = false;
    verbose.content('IME composition ended - resuming input processing', 'divEditor/index.js');
    // Trigger input handler after composition completes
    debouncedInputHandler(e);
  };

  editableDiv.addEventListener('input', onInput);
  editableDiv.addEventListener('compositionstart', onCompositionStart);
  editableDiv.addEventListener('compositionend', onCompositionEnd);

  return {
    flush() {
      debouncedInputHandler.flush();
    },
    destroy() {
      debouncedInputHandler.flush();
      editableDiv.removeEventListener('input', onInput);
      editableDiv.removeEventListener('compositionstart', onCompositionStart);
      editableDiv.removeEventListener('compositionend', onCompositionEnd);
    },
  };
}
