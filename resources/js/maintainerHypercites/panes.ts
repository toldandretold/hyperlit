/**
 * The two reader iframes (citing | cited). Jumping is a full reload per
 * candidate — the reader resolves a URL hash to a node only at LOAD time
 * (scrolling/internalNav.ts) and has no hashchange handler, so assigning a
 * src that differs only in the hash would neither reload nor scroll. Hence:
 * blank the frame, then set the target on the next frame. A postMessage
 * scroll bridge in utilities/embeddedReader.ts is the noted follow-up.
 *
 * Both panes frame OUR OWN reader (same origin, real books) — not fetched
 * publisher pages — so the fetched-source sandbox rule doesn't apply here.
 */

export class ReaderPane {
  private frame: HTMLIFrameElement;
  private placeholder: HTMLElement | null;
  private label: HTMLElement | null;
  private current = '';

  constructor(frameId: string, placeholderId: string, labelId: string) {
    this.frame = document.getElementById(frameId) as HTMLIFrameElement;
    this.placeholder = document.getElementById(placeholderId);
    this.label = document.getElementById(labelId);
  }

  /** Load `/book#target`, forcing a reload even when only the hash changed. */
  show(book: string, target: string | null, labelText: string): void {
    const url = `/${book}${target ? `#${target}` : ''}`;
    if (this.label) this.label.textContent = labelText;
    if (this.placeholder) this.placeholder.hidden = true;
    if (url === this.current) return;
    this.current = url;

    this.frame.src = 'about:blank';
    requestAnimationFrame(() => {
      // Selection may have moved on while we yielded a frame.
      if (this.current === url) this.frame.src = url;
    });
  }

  clear(placeholderText: string): void {
    this.current = '';
    this.frame.src = 'about:blank';
    if (this.placeholder) {
      this.placeholder.hidden = false;
      this.placeholder.textContent = placeholderText;
    }
  }
}
