/**
 * Link Mode for EditToolbar — an in-toolbar URL input (CitationMode-lite).
 *
 * Chosen over a dialog because a modal blurs the contenteditable and drops
 * the iOS keyboard; occupying the toolbar (like citation mode) keeps the
 * keyboard up and the selection restorable. Wraps the stored selection in
 * <a href class="external-link" target="_blank" rel="noopener noreferrer">,
 * or — when opened on an existing user link — pre-fills the href for editing
 * and offers unwrap via the remove button.
 */

import { log } from "../utilities/logger";
import { findBlockFromTarget } from "./undoManager";
import { getTextOffsetInElement } from "./toolbarDOMUtils";
import { asLineId, type LineId } from "../utilities/idHelpers";
import type { UndoManager } from "./undoManager";

/** Longest URL we accept — mirrors paste/utils/url-detector.ts (prebuilt
 *  bundle, so the ~10-line check is duplicated here rather than imported). */
const MAX_URL_LENGTH = 2048;

// On-device build check: `window.__hlLinkModeRev` in the console tells you
// which revision of this module the page is actually running.
(window as { __hlLinkModeRev?: number }).__hlLinkModeRev = 4;

export interface LinkModeContext {
  range: Range;
  existingAnchor: HTMLAnchorElement | null;
  bookId: string;
  undoManager: UndoManager;
  saveCallback: (id: LineId, html: string, options?: Record<string, unknown>) => Promise<unknown> | void;
  onUndoStackChanged?: () => void;
}

interface LinkModeOptions {
  toolbar?: HTMLElement | null;
  linkContainer?: HTMLElement | null;
  linkInput?: HTMLInputElement | null;
  confirmBtn?: HTMLElement | null;
  removeBtn?: HTMLElement | null;
  closeBtn?: HTMLElement | null;
}

/**
 * Validate + normalize a user-entered URL. Returns the normalized href or
 * null when unacceptable. http/https only (same posture as the paste
 * url-detector — javascript:/data:/file: never become hrefs).
 */
export function validateLinkUrl(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

export class LinkMode {
  toolbar: HTMLElement | null;
  linkContainer: HTMLElement | null;
  linkInput: HTMLInputElement | null;
  confirmBtn: HTMLElement | null;
  removeBtn: HTMLElement | null;
  closeBtn: HTMLElement | null;
  isOpen = false;
  private inert = false;
  private context: LinkModeContext | null = null;
  private boundConfirm: ((e: Event) => void) | null = null;
  private boundRemove: ((e: Event) => void) | null = null;
  private boundClose: ((e: Event) => void) | null = null;
  private boundKeydown: ((e: KeyboardEvent) => void) | null = null;
  private boundScrollLock: (() => void) | null = null;
  private boundInputTouch: ((e: TouchEvent) => void) | null = null;
  private boundBtnTouchEnd: ((e: TouchEvent) => void) | null = null;
  private boundOutsideDown: ((e: Event) => void) | null = null;
  private boundOutsideUp: ((e: Event) => void) | null = null;
  private outsideStart: { x: number; y: number } | null = null;
  private lockedScrollPosition: number | null = null;

  constructor(options: LinkModeOptions = {}) {
    this.toolbar = options.toolbar || null;
    this.linkContainer = options.linkContainer || null;
    this.linkInput = options.linkInput || null;
    this.confirmBtn = options.confirmBtn || null;
    this.removeBtn = options.removeBtn || null;
    this.closeBtn = options.closeBtn || null;
    this.inert = !this.toolbar || !this.linkContainer || !this.linkInput;
  }

  open(context: LinkModeContext): void {
    if (this.inert || this.isOpen) return;
    this.context = context;
    this.isOpen = true;

    this.toolbar!.classList.add("link-mode-active");
    this.linkContainer!.classList.remove("hidden");

    // Link mode is the one toolbar mode that REQUIRES a text selection, so the
    // hyperlight selection popup is showing right now — dismiss it (and its
    // toolbar state) while the URL is being entered. The selection toolbar's
    // handleSelection also guards on link-mode-active so a mouseup inside the
    // mode can't re-summon it; it returns naturally on the next selection.
    const hlButtons = document.getElementById("hyperlight-buttons");
    if (hlButtons) hlButtons.style.display = "none";
    const hlDelete = document.getElementById("delete-hyperlight");
    if (hlDelete) hlDelete.style.display = "none";
    this.toolbar!.classList.remove("hyperlight-selection-active");

    this.linkInput!.value = context.existingAnchor?.getAttribute("href") ?? "";
    if (this.removeBtn) {
      this.removeBtn.style.display = context.existingAnchor ? "" : "none";
    }

    // MOBILE SCROLL LOCK + desktop-only autofocus (citationMode precedent —
    // mobile autofocus causes wild iOS scrolling).
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.lockedScrollPosition = window.scrollY || 0;
      this.boundScrollLock = () => {
        if (window.scrollY !== this.lockedScrollPosition) {
          window.scrollTo(0, this.lockedScrollPosition ?? 0);
        }
      };
      window.addEventListener("scroll", this.boundScrollLock, { passive: false });

      // MOBILE FIX (citationMode precedent): a plain tap on the input doesn't
      // reliably focus it on iOS here — the toolbar's capture-phase touch
      // guards and iOS's scroll-to-focus fight it. Intercept the touch and
      // focus manually, scroll-free. ONLY while unfocused: once the field has
      // focus, native touch behavior must run or the long-press Paste callout
      // (and caret repositioning) never appears.
      this.boundInputTouch = (e: TouchEvent) => {
        if (document.activeElement === this.linkInput) return;
        e.preventDefault();
        e.stopPropagation();
        this.linkInput!.focus({ preventScroll: true });
      };
      this.linkInput!.addEventListener("touchend", this.boundInputTouch, { passive: false });
    } else {
      setTimeout(() => this.linkInput!.focus(), 100);
    }

    this.boundConfirm = (e: Event) => { e.preventDefault(); void this.confirm(); };
    this.boundRemove = (e: Event) => { e.preventDefault(); void this.removeLink(); };
    this.boundClose = (e: Event) => { e.preventDefault(); this.close(); };
    this.boundKeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); void this.confirm(); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    };
    this.confirmBtn?.addEventListener("click", this.boundConfirm);
    this.removeBtn?.addEventListener("click", this.boundRemove);
    this.closeBtn?.addEventListener("click", this.boundClose);
    this.linkInput!.addEventListener("keydown", this.boundKeydown);

    // TOUCHEND activation for the ✓ ⌫ × buttons — click-only listeners are
    // dead on this toolbar whenever ANY keyboard-open touch guard eats the
    // touchstart (synthesized clicks never happen). Every top-row toolbar
    // button acts on touchend for exactly this reason; these get the same.
    // preventDefault also suppresses the synthesized click, so no double-fire.
    this.boundBtnTouchEnd = (e: TouchEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (this.confirmBtn && (target === this.confirmBtn || this.confirmBtn.contains(target))) {
        e.preventDefault(); e.stopPropagation(); void this.confirm();
      } else if (this.removeBtn && (target === this.removeBtn || this.removeBtn.contains(target))) {
        e.preventDefault(); e.stopPropagation(); void this.removeLink();
      } else if (this.closeBtn && (target === this.closeBtn || this.closeBtn.contains(target))) {
        e.preventDefault(); e.stopPropagation(); this.close();
      }
    };
    this.linkContainer!.addEventListener("touchend", this.boundBtnTouchEnd, { passive: false });

    // TAP/CLICK OUTSIDE closes the mode (deferred a tick so the opening tap
    // can't instantly close it; movement-guarded so a scroll doesn't).
    this.boundOutsideDown = (e: Event) => {
      const t = (e as TouchEvent).touches?.[0];
      this.outsideStart = t ? { x: t.clientX, y: t.clientY } : null;
    };
    this.boundOutsideUp = (e: Event) => {
      const target = e.target as Element | null;
      if (!target || target.closest("#edit-toolbar")) return; // toolbar taps are the mode's own
      if (e.type === "touchend") {
        const t = (e as TouchEvent).changedTouches?.[0];
        if (this.outsideStart && t) {
          const moved = Math.hypot(t.clientX - this.outsideStart.x, t.clientY - this.outsideStart.y);
          if (moved > 10) return; // a scroll, not a tap
        }
      }
      this.close();
    };
    setTimeout(() => {
      if (!this.isOpen || !this.boundOutsideDown || !this.boundOutsideUp) return;
      document.addEventListener("touchstart", this.boundOutsideDown, { capture: true, passive: true });
      document.addEventListener("touchend", this.boundOutsideUp, { capture: true, passive: true });
      document.addEventListener("click", this.boundOutsideUp, { capture: true });
    }, 0);

    this._refreshKeyboardLayout();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.context = null;

    this.toolbar!.classList.remove("link-mode-active");
    this.linkContainer!.classList.add("hidden");

    if (this.boundConfirm) this.confirmBtn?.removeEventListener("click", this.boundConfirm);
    if (this.boundRemove) this.removeBtn?.removeEventListener("click", this.boundRemove);
    if (this.boundClose) this.closeBtn?.removeEventListener("click", this.boundClose);
    if (this.boundKeydown) this.linkInput?.removeEventListener("keydown", this.boundKeydown);
    this.boundConfirm = this.boundRemove = this.boundClose = null;
    this.boundKeydown = null;

    if (this.boundScrollLock) {
      window.removeEventListener("scroll", this.boundScrollLock);
      this.boundScrollLock = null;
      this.lockedScrollPosition = null;
    }
    if (this.boundInputTouch) {
      this.linkInput?.removeEventListener("touchend", this.boundInputTouch);
      this.boundInputTouch = null;
    }
    if (this.boundBtnTouchEnd) {
      this.linkContainer?.removeEventListener("touchend", this.boundBtnTouchEnd);
      this.boundBtnTouchEnd = null;
    }
    if (this.boundOutsideDown) {
      document.removeEventListener("touchstart", this.boundOutsideDown, { capture: true } as EventListenerOptions);
      this.boundOutsideDown = null;
    }
    if (this.boundOutsideUp) {
      document.removeEventListener("touchend", this.boundOutsideUp, { capture: true } as EventListenerOptions);
      document.removeEventListener("click", this.boundOutsideUp, { capture: true } as EventListenerOptions);
      this.boundOutsideUp = null;
    }
    this.outsideStart = null;

    this._refreshKeyboardLayout();
  }

  /** Apply the entered URL: rewrite an existing anchor, or wrap the selection. */
  async confirm(): Promise<void> {
    const context = this.context;
    if (!context || !this.linkInput) return;

    const href = validateLinkUrl(this.linkInput.value);
    if (!href) {
      // Nudge, keep the mode open for correction.
      this.linkInput.setAttribute("aria-invalid", "true");
      this.linkInput.classList.add("link-input-invalid");
      setTimeout(() => {
        this.linkInput?.removeAttribute("aria-invalid");
        this.linkInput?.classList.remove("link-input-invalid");
      }, 1200);
      return;
    }

    try {
      if (context.existingAnchor) {
        await this._mutateBlock(context, context.existingAnchor, () => {
          context.existingAnchor!.setAttribute("href", href);
        });
      } else {
        await this._mutateBlock(context, context.range.startContainer, () => {
          const anchor = document.createElement("a");
          anchor.setAttribute("href", href);
          anchor.className = "external-link";
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
          // extractContents + insertNode, NOT surroundContents — the latter
          // throws on partially-selected nodes (e.g. half a <strong>).
          const range = context.range;
          const fragment = range.extractContents();
          anchor.appendChild(fragment);
          range.insertNode(anchor);
          // Seat the caret after the new link.
          const sel = window.getSelection();
          if (sel) {
            const after = document.createRange();
            after.setStartAfter(anchor);
            after.collapse(true);
            sel.removeAllRanges();
            sel.addRange(after);
          }
        });
      }
    } catch (error) {
      log.error("Link insert failed", "editToolbar/linkMode", error);
    }

    this.close();
  }

  /** Unwrap the existing anchor (keep its children in place). */
  async removeLink(): Promise<void> {
    const context = this.context;
    const anchor = context?.existingAnchor;
    if (!context || !anchor) return;

    try {
      await this._mutateBlock(context, anchor, () => {
        anchor.replaceWith(...Array.from(anchor.childNodes));
      });
    } catch (error) {
      log.error("Link remove failed", "editToolbar/linkMode", error);
    }

    this.close();
  }

  /**
   * Shared mutate-with-undo-and-save wrapper: snapshot the block, run the
   * mutation, push the {type:'input'} undo entry (insertFootnote's shape),
   * normalize, save the block's outerHTML.
   */
  private async _mutateBlock(context: LinkModeContext, from: Node, mutate: () => void): Promise<void> {
    const blockEl = findBlockFromTarget(from);
    if (!blockEl || !blockEl.id) {
      log.error("Link mode: no block element found for mutation", "editToolbar/linkMode");
      return;
    }

    const oldHTML = blockEl.innerHTML;
    let cursorBefore = 0;
    try {
      cursorBefore = getTextOffsetInElement(blockEl, context.range.startContainer, context.range.startOffset);
    } catch { /* ignore */ }

    context.undoManager.sealGroup();
    mutate();
    blockEl.normalize();

    const newHTML = blockEl.innerHTML;
    if (newHTML !== oldHTML) {
      let cursorAfter = 0;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.focusNode) {
        try {
          cursorAfter = getTextOffsetInElement(blockEl, sel.focusNode, sel.focusOffset);
        } catch { /* ignore */ }
      }
      context.undoManager._pushUndo(context.bookId, {
        type: "input",
        elementId: blockEl.id,
        oldHTML,
        newHTML,
        bookId: context.bookId,
        cursorBefore,
        cursorAfter,
      });
      context.onUndoStackChanged?.();
      await context.saveCallback(asLineId(blockEl.id), blockEl.outerHTML);
    }
  }

  /** The toolbar's height changes when the mode toggles — reposition above the keyboard. */
  private _refreshKeyboardLayout(): void {
    const keyboardManager = (window as unknown as { activeKeyboardManager?: { isKeyboardOpen?: boolean; moveToolbarAboveKeyboard: (...args: unknown[]) => void } }).activeKeyboardManager;
    if (keyboardManager && keyboardManager.isKeyboardOpen) {
      keyboardManager.moveToolbarAboveKeyboard(
        document.getElementById("edit-toolbar"),
        document.getElementById("search-toolbar"),
        document.getElementById("citation-toolbar"),
        document.getElementById("bottom-right-buttons"),
        document.querySelector(".main-content"),
      );
    }
  }
}
