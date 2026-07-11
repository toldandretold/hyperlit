// SourceContainerManager — coordinator for the #source-container modal that the
// #cloudRef button opens. Owns the core lifecycle (open/close/animation +
// listener wiring) inline and delegates every concern method to its sibling
// module (downloads / editForm / visibilityControl / creatorTools/* / aiReview/*).
// The class is the single dispatch hub: extracted functions take this instance
// as `self` and call peers via `self.*`, so the only static edges are
// index → submodules → leaves (acyclic). The default export is the singleton
// `sourceManager`; the #cloudRef trigger lives in ../cloudRef/cloudRefButton.
import { ContainerManager } from "../utilities/containerManager";
import { book } from "../../app";
import { buildSourceHtml } from "./buildSourceHtml";
import { exportBookAsMarkdown, exportBookAsDocxStyled, exportBookAsEpub, downloadAllForBook } from "./downloads";
import {
  handleEditClick, showEditForm, populateEditForm, showOptionalFieldsForType,
  populateFieldsFromBibtex, cleanUrl, validateUrl, expandForEditForm,
  setupEditFormListeners, saveEditForm, hideEditForm, handleFormSubmit,
  syncLibraryRecordToBackend, collectFormData, refreshCitationDisplay,
} from "./editForm";
import { attachVisibilityControlListeners } from "./visibilityControl";
import { loadCreatorTools } from "./creatorTools/index";
import { loadVersionHistory } from "./creatorTools/versionHistory";
import { loadReconvertInfo, handleReconvert, _awaitReconvert } from "./creatorTools/reconvert";
import { handleReupload } from "./creatorTools/reupload";
import { handleDeleteBook } from "./creatorTools/deleteBook";
import { loadHarvestSection, handleHarvestNetwork, startHarvestPolling, stopHarvestPolling, pollHarvestStatus } from "./creatorTools/harvestNetwork";
import { loadAiReviewStatus, setAiReviewState, handleAiReviewGenerate, ensureAiReviewLivePanel } from "./aiReview/index";
import { handleCheckSource, wireSourceStatus } from "./checkSource";
import { startAiReviewPolling, stopAiReviewPolling, pollAiReviewStatus } from "./aiReview/polling";
import { openAiReviewVizOverlay, closeAiReviewVizOverlay, fetchPipelineMap, renderPipelineViz, syncPipelineHighlights } from "./aiReview/pipelineViz";

export class SourceContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    this.setupSourceContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.isInEditMode = false; // Track if we're currently in edit mode
  }

  rebindElements() {
    // Call the parent rebindElements first
    super.rebindElements();

    // Reapply styles after finding new DOM elements
    this.setupSourceContainerStyles();
  }

  // Override parent's closeOnOverlayClick — always close (auto-save handled by closeContainer)
  async closeOnOverlayClick() {
    await this.closeContainer();
  }

  setupSourceContainerStyles() {
    // CSS handles all styling - this method kept for compatibility
    // but no longer sets inline styles
  }

  attachInternalListeners() {
    const mdBtn = this.container.querySelector("#download-md");
    const docxBtn = this.container.querySelector("#download-docx");
    const editBtn = this.container.querySelector("#edit-source");

    if (mdBtn && !mdBtn._listenerAttached) {
      mdBtn._listenerAttached = true;
      mdBtn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        exportBookAsMarkdown(book);
      });
    }
    if (docxBtn && !docxBtn._listenerAttached) {
      docxBtn._listenerAttached = true;
      docxBtn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        exportBookAsDocxStyled(book);
      });
    }
    const epubBtn = this.container.querySelector("#download-epub");
    if (epubBtn && !epubBtn._listenerAttached) {
      epubBtn._listenerAttached = true;
      epubBtn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        exportBookAsEpub(book);
      });
    }
    const downloadAllBtn = this.container.querySelector("#download-all");
    if (downloadAllBtn && !downloadAllBtn._listenerAttached) {
      downloadAllBtn._listenerAttached = true;
      downloadAllBtn.addEventListener("click", async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        await downloadAllForBook(downloadAllBtn, book);
      });
    }
    if (editBtn && !editBtn._listenerAttached) {
      editBtn._listenerAttached = true;
      editBtn.addEventListener("click", () => this.handleEditClick());
    }

    // Unified visibility control (Public / Private / Encrypted)
    attachVisibilityControlListeners(this);

    // Creator tools toggle (lazy-load on first expand)
    // Guard against duplicate listeners from hideEditForm → attachInternalListeners
    const creatorToolsToggle = this.container.querySelector("#creator-tools-toggle");
    if (creatorToolsToggle && !creatorToolsToggle._listenerAttached) {
      creatorToolsToggle._listenerAttached = true;
      creatorToolsToggle.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        const content = this.container.querySelector("#creator-tools-content");
        if (!content) return;
        const isExpanded = content.style.display !== 'none';
        content.style.display = isExpanded ? 'none' : 'block';
        creatorToolsToggle.classList.toggle('expanded', !isExpanded);
        if (!isExpanded) {
          if (!this._creatorToolsLoaded) {
            this.loadCreatorTools();
          }
          // Scroll so the expanded content is visible
          setTimeout(() => {
            content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 50);
        }
      });
    }

    const aiReviewBtn = this.container.querySelector("#ai-review-btn");
    if (aiReviewBtn && !aiReviewBtn.disabled && !aiReviewBtn._listenerAttached) {
      aiReviewBtn._listenerAttached = true;
      aiReviewBtn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        const infoPanel = this.container.querySelector("#ai-review-info");
        if (infoPanel) {
          infoPanel.style.display = infoPanel.style.display === 'none' ? 'block' : 'none';
        }
      });
    }

    const aiCostToggle = this.container.querySelector('.ai-review-cost-info-toggle');
    if (aiCostToggle && !aiCostToggle._listenerAttached) {
      aiCostToggle._listenerAttached = true;
      const detail = this.container.querySelector('.ai-review-cost-info-detail');
      if (detail) {
        const toggle = () => { detail.style.display = detail.style.display === 'none' ? 'inline' : 'none'; };
        aiCostToggle.addEventListener('click', toggle);
        aiCostToggle.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      }
    }

    const aiReviewGenerate = this.container.querySelector("#ai-review-generate");
    if (aiReviewGenerate && !aiReviewGenerate._listenerAttached) {
      aiReviewGenerate._listenerAttached = true;
      aiReviewGenerate.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleAiReviewGenerate();
      });
    }

    const checkSourceBtn = this.container.querySelector("#check-source-btn");
    if (checkSourceBtn && !checkSourceBtn._listenerAttached) {
      checkSourceBtn._listenerAttached = true;
      checkSourceBtn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleCheckSource();
      });
    }

    // Delegated wiring for the verification-category pills (each expands its explanation).
    // Attached to the section element, which persists across the verify re-render.
    const sourceStatusSection = this.container.querySelector("#check-source-section");
    if (sourceStatusSection) wireSourceStatus(sourceStatusSection);

    this.loadAiReviewStatus();
  }

  /**
   * Resolve an open/close animation: clear `isAnimating` (and run `onSettle`) on
   * EITHER the container's own `transitionend` OR a duration fallback, and cancel
   * any settle still pending from a previous (interrupted) animation so its
   * callback can't later flip `isAnimating` / add `.hidden` under a newer one.
   */
  _settleAnimation(onSettle?: any) {
    if (this._cancelSettle) this._cancelSettle();

    let done = false;
    const teardown = () => {
      this.container.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
      this._cancelSettle = null;
    };
    const settle = () => {
      if (done) return;
      done = true;
      teardown();
      if (onSettle) onSettle();
      this.isAnimating = false;
    };
    const onEnd = (e: any) => { if (e.target === this.container) settle(); };
    this.container.addEventListener("transitionend", onEnd);
    // > the 0.3s `transition: transform` in containers.css.
    const timer = setTimeout(settle, 400);
    this._cancelSettle = () => { done = true; teardown(); };
  }

  async openContainer() {
    if (this.isAnimating || !this.container) return;
    this.isAnimating = true;

    this._creatorToolsLoaded = false;

    const html = await buildSourceHtml(book);
    this.container.innerHTML = html;

    this.attachInternalListeners();

    // CSS handles all positioning and animation
    this.container.classList.remove("hidden");
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;
    this.updateState(); // Adds .open class via parent's updateState()
    this._engageFocusTrap(); // base ContainerManager: Tab trap + Escape + focus restore

    this._settleAnimation();
  }

  async closeContainer() {
    // Honour a close even while the open animation is still in flight: gate on
    // isOpen (set synchronously by open/close) rather than isAnimating.
    if (!this.container || !this.isOpen) return;

    if (this.isInEditMode) {
      await this.saveEditForm();
      this.hideEditForm();
    }

    this.isAnimating = true;

    // Clear inline styles left behind by a resize drag (width/right/left/transform set
    // with !important by ContainerDragger). Removing `.open` then waiting for
    // transitionend to add `.hidden`; an inline transform would pin the panel
    // on-screen, so we clear inline styles first. Mirrors the base
    // ContainerManager.closeContainer() inline-clear. The resized width is
    // reapplied on reopen from the containerCustomizer stylesheet.
    const cs = this.container.style;
    cs.transform = '';
    cs.width = '';
    cs.maxWidth = '';
    cs.left = '';
    cs.right = '';
    cs.top = '';
    cs.bottom = '';

    this.stopAiReviewPolling();
    this.stopHarvestPolling();
    this.isOpen = false;
    (window as any).activeContainer = "main-content";
    this.updateState(); // Removes .open class via parent's updateState()
    this._releaseFocusTrap();

    this._settleAnimation(() => this.container.classList.add("hidden"));
  }

  // ── Delegators ────────────────────────────────────────────────────────────
  // Each concern method's body lives in its sibling module as a function taking
  // `self`; these thin wrappers are the dispatch table so peer calls (self.*)
  // resolve back here regardless of which module they originated in.

  // editForm
  handleEditClick() { return handleEditClick(this); }
  showEditForm() { return showEditForm(this); }
  populateEditForm(record: any) { return populateEditForm(this, record); }
  showOptionalFieldsForType(type: any, record?: any) { return showOptionalFieldsForType(this, type, record); }
  populateFieldsFromBibtex() { return populateFieldsFromBibtex(this); }
  cleanUrl(url: any) { return cleanUrl(this, url); }
  validateUrl(value: any) { return validateUrl(this, value); }
  expandForEditForm() { return expandForEditForm(this); }
  setupEditFormListeners(record: any) { return setupEditFormListeners(this, record); }
  saveEditForm() { return saveEditForm(this); }
  hideEditForm() { return hideEditForm(this); }
  handleFormSubmit(originalRecord: any) { return handleFormSubmit(this, originalRecord); }
  syncLibraryRecordToBackend(libraryRecord: any) { return syncLibraryRecordToBackend(this, libraryRecord); }
  collectFormData() { return collectFormData(this); }
  refreshCitationDisplay() { return refreshCitationDisplay(this); }

  // checkSource
  handleCheckSource() { return handleCheckSource(this); }

  // creatorTools
  loadCreatorTools() { return loadCreatorTools(this); }
  loadVersionHistory() { return loadVersionHistory(this); }
  loadReconvertInfo() { return loadReconvertInfo(this); }
  handleReconvert() { return handleReconvert(this); }
  _awaitReconvert(result: any, bookId: any, progressUI: any) { return _awaitReconvert(this, result, bookId, progressUI); }
  handleReupload(file: any) { return handleReupload(this, file); }
  handleDeleteBook() { return handleDeleteBook(this); }

  // harvestNetwork (Source Network Harvester)
  loadHarvestSection() { return loadHarvestSection(this); }
  handleHarvestNetwork() { return handleHarvestNetwork(this); }
  startHarvestPolling(intervalMs?: any) { return startHarvestPolling(this, intervalMs); }
  stopHarvestPolling() { return stopHarvestPolling(this); }
  pollHarvestStatus() { return pollHarvestStatus(this); }

  // aiReview
  handleAiReviewGenerate() { return handleAiReviewGenerate(this); }
  loadAiReviewStatus() { return loadAiReviewStatus(this); }
  setAiReviewState(state: any, currentStep?: any, opts?: any) { return setAiReviewState(this, state, currentStep, opts); }
  ensureAiReviewLivePanel() { return ensureAiReviewLivePanel(this); }
  startAiReviewPolling(intervalMs?: any) { return startAiReviewPolling(this, intervalMs); }
  stopAiReviewPolling() { return stopAiReviewPolling(this); }
  pollAiReviewStatus() { return pollAiReviewStatus(this); }
  openAiReviewVizOverlay() { return openAiReviewVizOverlay(this); }
  closeAiReviewVizOverlay() { return closeAiReviewVizOverlay(this); }
  fetchPipelineMap() { return fetchPipelineMap(this); }
  renderPipelineViz(pipeline: any) { return renderPipelineViz(this, pipeline); }
  syncPipelineHighlights(bookId: any) { return syncPipelineHighlights(this, bookId); }
}

// This instance is created only ONCE.
const sourceManager: any = new SourceContainerManager(
  "source-container",
  "source-overlay",
  "cloudRef",
  ["main-content"]
);
export default sourceManager;

// Destroy function for cleanup during navigation
export function destroySourceManager() {
  if (sourceManager) {
    console.log('🧹 Destroying source container manager');
    sourceManager.destroy();
    return true;
  }
  return false;
}
