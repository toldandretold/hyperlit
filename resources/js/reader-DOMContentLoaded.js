import {
    mainContentDiv,
    book,
    markdownContent
} from './app.js'; 

import {
    convertMarkdownToHtml
} from './convert-markdown.js';

import { // observer, 
    isValidContentElement,
    restoreScrollPosition,
    navigateToInternalId
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
} from './cache-indexedDB.js';

import {
    loadMarkdownFile
} from './initializePage.js';

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

import NavButtons from "./nav-buttons.js";

import { currentLazyLoader } from './initializePage.js';



  

if (!window.isInitialized) {
    window.isInitialized = true;

    document.addEventListener("DOMContentLoaded", async () => {

        window.activeContainer = "main-content";

        // Utility function to bust the cache using a lastModified timestamp
        window.getFreshUrl = function(url, lastModified) {
          return `${url}?v=${lastModified}`;
        };
        window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

        window.isNavigatingToInternalId = false;

        console.log("✅ DOM is ready. Loading Markdown file...");

        // cache-indexedDB.js
        window.db = await openDatabase();
        console.log("✅ IndexedDB initialized.");


        // initializePage.js
        await loadMarkdownFile();
        
        // gets scroll position from session storage 
        restoreScrollPosition();

        attachMarkListeners();

        // Load Table of Contents
        generateTableOfContents("toc-container", "toc-toggle-button");


        const navButtons = new NavButtons({
            elementId: "nav-buttons", // This should match the id in your HTML.
            tapThreshold: 10, // Adjust if needed.
            });
        navButtons.init();
        
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
            // Pass the lazyLoader instance as the second argument.
            navigateToInternalId(targetId, currentLazyLoader);
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

    });
}
