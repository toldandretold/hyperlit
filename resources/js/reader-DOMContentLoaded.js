import {
    convertMarkdownToHtml
} from './convert-markdown.js';

import { observer, 
    isValidContentElement,
    restoreScrollPosition,
    handleNavigation,
    navigateToInternalId,
    reattachScrollObserver
} from './scrolling.js';

import { 
    refContainer, 
    refOverlay, 
    isRefOpen,
    openReferenceContainer,
    closeReferenceContainer,
    displayFootnote
} from './footnotes.js';

import { 
    openDatabase, 
    DB_VERSION, 
    checkIndexedDBSize,
    getNodeChunksFromIndexedDB,
    saveNodeChunksToIndexedDB,
    getFootnotesFromIndexedDB,
    saveFootnotesToIndexedDB
} from './cache-indexedDB.js';

import {
    loadMarkdownFile
} from './lazy-loading.js';

import {
    attachMarkListeners,
    handleMarkClick,
    handleMarkHover,
    handleMarkHoverOut
} from './hyper-lights-cites.js';

import {
    generateTableOfContents,
    tocContainer,
    tocOverlay,
    tocButton,
    toggleTOC
} from './toc.js';

export const mainContentDiv = document.getElementById("main-content"); 
    
export const markdownContent = ""; // Store Markdown globally

export const book = mainContentDiv.getAttribute('data-book');

if (!window.isInitialized) {
    window.isInitialized = true;

    document.addEventListener("DOMContentLoaded", async () => {

        // Utility function to bust the cache using a lastModified timestamp
        window.getFreshUrl = function(url, lastModified) {
          return `${url}?v=${lastModified}`;
        };
        window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

        window.isNavigatingToInternalId = false;

        console.log("✅ DOM is ready. Loading Markdown file...");

        // Initialize IndexedDB
        window.db = await openDatabase();
        console.log("✅ IndexedDB initialized.");

        // Load main Markdown file
        await loadMarkdownFile();
        
        // gets scroll position from session storage 
        restoreScrollPosition();

        attachMarkListeners();

        // Lazy-Loading Scroll Observer:
        // observe all valid elements inside main-content div that have an id
        // validity determined in scrolling.js. it filters out sentinels, overlays and other non-content elements
        // as these are not necessary for the lazy loading
        document.querySelectorAll("#main-content [id]").forEach((el) => {
            if (isValidContentElement(el)) observer.observe(el);
        });

        // Load Table of Contents
        generateTableOfContents("toc-container", "toc-toggle-button");
        
        if (!tocContainer || !tocOverlay || !tocButton) {
            console.error("TOC elements are missing in the DOM.");
            return;
        }

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
}
