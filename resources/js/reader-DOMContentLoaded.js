// reader-DOMContentLoaded.js
import { observer, isValidContentElement } from './scrolling.js';

// reader-DOMContentLoaded.js
import { 
    refContainer, 
    refOverlay, 
    isRefOpen
} from './footnotes.js';

document.addEventListener("DOMContentLoaded", async () => {

    const mainContentDiv = document.getElementById("main-content"); // This already exists
    window.mainContentDiv = mainContentDiv;
    window.markdownContent = ""; // Store Markdown globally

    // Utility function to bust the cache using a lastModified timestamp
    window.getFreshUrl = function(url, lastModified) {
      return `${url}?v=${lastModified}`;
    };
    window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

    window.isNavigatingToInternalId = false;

    console.log("✅ DOM is ready. Loading Markdown file...");

    // ✅ Initialize IndexedDB
    window.db = await openDatabase();
    console.log("✅ IndexedDB initialized.");

    // ✅ Load main Markdown file
    await loadMarkdownFile();

    console.log("🔄 Checking for saved scroll position or internal link before lazy loading...");
    restoreScrollPosition();

    if (typeof attachMarkListeners === 'function') {
        console.log('🎯 Initial attachment of mark listeners');
        attachMarkListeners();
    }

    // ✅ Attach observer to content elements
    document.querySelectorAll("#main-content [id]").forEach((el) => {
        if (isValidContentElement(el)) observer.observe(el);
    });

    // ✅ Load Table of Contents
    generateTableOfContents("toc-container", "toc-toggle-button");

    // ✅ TOC Handling
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");
    
    if (!tocContainer || !tocOverlay || !tocButton) {
        console.error("TOC elements are missing in the DOM.");
        return;
    }

    let isTOCOpen = false;
    function updateTOCState() {
        if (isTOCOpen) {
            console.log("Opening TOC...");
            tocContainer.classList.add("open");
            tocOverlay.classList.add("active");
        } else {
            console.log("Closing TOC...");
            tocContainer.classList.remove("open");
            tocOverlay.classList.remove("active");
        }
    }

    tocButton.addEventListener("click", () => {
        isTOCOpen = !isTOCOpen;
        updateTOCState();
    });

    tocOverlay.addEventListener("click", () => {
        if (isTOCOpen) {
            isTOCOpen = false;
            updateTOCState();
        }
    });

    tocContainer.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link) {
            event.preventDefault();
            isTOCOpen = false;
            updateTOCState();
            const targetId = link.hash?.substring(1);
            if (!targetId) return;
            console.log(`📌 Navigating via TOC to: ${targetId}`);
            navigateToInternalId(targetId);
            setTimeout(() => {
                console.log(`🔄 Reattaching scroll observer after TOC navigation...`);
                reattachScrollObserver();
            }, 600);
        }
    });

    // ✅ Internal Link Navigation Handling
    document.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link && link.hash && link.hash.startsWith("#")) {
            event.preventDefault();
            const targetId = link.hash.substring(1);
            navigateToInternalId(targetId);
        }
    });

    // ✅ Footnotes Click Handling (Replaces `jsonPath`)
    document.addEventListener("click", async (event) => {
        const noteElement = event.target.closest("sup.note");
        if (noteElement) {
            event.preventDefault();
            const noteKey = noteElement.dataset.noteKey;
            const parentId = noteElement.closest("[id]")?.id;
            if (!noteKey || !parentId) {
                console.warn("Missing note key or parent ID for footnote.");
                return;
            }

            // ✅ Load footnotes from memory, IndexedDB, or fetch from server
            let footnotesData = window.footnotesData || await getFootnotesFromIndexedDB();
            
            if (!footnotesData) {
                console.log("🌍 Fetching footnotes from server...");
                const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";
                const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
                const response = await fetch(freshJsonUrl);
                footnotesData = await response.json();
                await saveFootnotesToIndexedDB(footnotesData);
                window.footnotesData = footnotesData;
            }

            // ✅ Search for the footnote within the retrieved data
            const section = footnotesData.find((sec) =>
                Object.values(sec.footnotes || {}).some(
                    (fn) => fn.line_number.toString() === parentId && fn.content
                )
            );

            if (!section) {
                console.warn(`No matching section found for line ${parentId}.`);
                return;
            }

            const footnote = section.footnotes[noteKey];
            if (!footnote || footnote.line_number.toString() !== parentId) {
                console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
                return;
            }

            const footnoteHtml = convertMarkdownToHtml(footnote.content);
            openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
        }
    });

    // ✅ Footnotes Overlay Close Handler
    refOverlay.addEventListener("click", () => {
        if (isRefOpen) {
            console.log("Closing footnotes container via overlay click...");
            closeReferenceContainer();
        }
    });

    // ✅ Detect Navigation Type
    const navEntry = performance.getEntriesByType("navigation")[0] || {};
    const navType = navEntry.type || "navigate";

    if (navType === "reload") {
        console.log("🔄 Page refreshed (F5 or Ctrl+R).");
    } else if (navType === "back_forward") {
        console.log("⬅️➡️ Navigation via Back/Forward buttons.");
    } else {
        console.log("🔗 Entered page via direct URL or new tab.");
    }

    handleNavigation();
});

    
