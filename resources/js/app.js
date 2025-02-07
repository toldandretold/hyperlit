// ========= Global Setup =========

console.log('App.js is loaded');

let book = document.getElementById('main-content').getAttribute('data-book');
window.book = book;

const mainContentDiv = document.getElementById("main-content"); // This already exists
window.mainContentDiv = mainContentDiv;
window.markdownContent = ""; // Store Markdown globally

// Utility function to bust the cache using a lastModified timestamp
window.getFreshUrl = function(url, lastModified) {
  return `${url}?v=${lastModified}`;
};
window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

window.isNavigatingToInternalId = false;

// ========= Mark Listeners =========
function attachMarkListeners() {
    const markTags = document.querySelectorAll("mark[id]");
    markTags.forEach(function (mark) {
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);
        mark.dataset.listenerAttached = true;
    });
    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags.`);
}
window.attachMarkListeners = attachMarkListeners;   

function handleMarkClick(event) {
    event.preventDefault();
    const highlightId = event.target.id;
    console.log(`Mark clicked: ${highlightId}`);
    window.location.href = `/${window.book}/hyperlights#${highlightId}`;
}
window.handleMarkClick = handleMarkClick;

function handleMarkHover(event) {
    event.target.style.textDecoration = "underline";
}
window.handleMarkHover = handleMarkHover;

function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none";
}
window.handleMarkHoverOut = handleMarkHoverOut;

// ========= Scrolling =========
function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  const container = document.getElementById("main-content");
  if (!container) {
    console.error('Container with id "main-content" not found!');
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Container current scrollTop:", container.scrollTop);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
}
window.scrollElementIntoMainContent = scrollElementIntoMainContent;

function lockScrollToTarget(targetElement, headerOffset = 50, attempts = 3) {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) clearInterval(interval);
  }, 300);
}
window.lockScrollToTarget = lockScrollToTarget;



function reloadMarkdownFromCache() {
    console.log("✅ Reloading Markdown from cache...");
    let cachedMarkdown = localStorage.getItem("cachedMarkdown");
    if (cachedMarkdown) {
        console.log("✅ Using Cached Markdown for rendering.");
        window.markdownContent = cachedMarkdown;
        window.nodeChunks = parseMarkdownIntoChunks(cachedMarkdown);
        initializePage();
    } else {
        console.warn("⚠️ No cached Markdown found, fetching...");
        loadMarkdownContent();
    }
}

// ========= IndexedDB Setup =========
const DB_VERSION = 4; // Use a consistent version
async function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("MarkdownDB", DB_VERSION);
        request.onupgradeneeded = event => {
            console.log("📌 Resetting IndexedDB...");
            const db = event.target.result;
            if (db.objectStoreNames.contains("nodeChunks")) {
                db.deleteObjectStore("nodeChunks");
            }
            if (db.objectStoreNames.contains("markdownStore")) {
                db.deleteObjectStore("markdownStore");
            }
            db.createObjectStore("nodeChunks");
            db.createObjectStore("markdownStore");
            console.log("✅ IndexedDB stores created.");
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => {
            console.error("❌ IndexedDB failed to open:", event.target.error);
            reject("IndexedDB Error: " + event.target.error);
        };
    });
}
window.openDatabase = openDatabase;

async function checkIndexedDBSize() {
    let dbRequest = indexedDB.open("MarkdownDB", DB_VERSION); // Use same version
    dbRequest.onsuccess = function(event) {
        let db = event.target.result;
        let tx = db.transaction("nodeChunks", "readonly");
        let store = tx.objectStore("nodeChunks");
        let getRequest = store.get("latest");
        getRequest.onsuccess = function() {
            let data = getRequest.result;
            if (data) {
                let sizeInKB = new Blob([JSON.stringify(data)]).size / 1024;
                console.log("📂 IndexedDB nodeChunks Size:", sizeInKB.toFixed(2), "KB");
            } else {
                console.log("❌ No data found in IndexedDB.");
            }
        };
        getRequest.onerror = function() {
            console.log("❌ Error retrieving data from IndexedDB.");
        };
    };
    dbRequest.onerror = function() {
        console.log("❌ Error opening IndexedDB.");
    };
}
window.checkIndexedDBSize = checkIndexedDBSize;

async function getNodeChunksFromIndexedDB() {
    if (!window.db) {
        window.db = await openDatabase();
    }
    const tx = window.db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    return new Promise((resolve, reject) => {
        const request = store.get("latest");
        request.onsuccess = () => {
            console.log("✅ Retrieved nodeChunks from IndexedDB.");
            resolve(request.result || []);
        };
        request.onerror = () => reject("❌ Error loading nodeChunks from IndexedDB");
    });
}
window.getNodeChunksFromIndexedDB = getNodeChunksFromIndexedDB;

async function saveNodeChunksToIndexedDB(nodeChunks) {
    console.log("📝 Attempting to save nodeChunks to IndexedDB:", nodeChunks);
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    store.put(nodeChunks, "latest");
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log("✅ nodeChunks successfully saved in IndexedDB.");
            resolve();
        };
        tx.onerror = () => {
            console.error("❌ Error saving nodeChunks to IndexedDB");
            reject();
        };
    });
}
window.saveNodeChunksToIndexedDB = saveNodeChunksToIndexedDB;

function parseMarkdownIntoChunks(markdown) {
    const lines = markdown.split("\n");
    const chunks = [];
    let currentChunk = [];
    let currentChunkId = 0;
    let currentStartLine = 1;
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        const adjustedLineNumber = i + 1;
        let block = null;
        if (trimmed.match(/^#{1,5}\s/)) {
            block = { 
              type: "heading", 
              level: trimmed.match(/^#{1,5}/)[0].length, 
              startLine: adjustedLineNumber, 
              content: trimmed.replace(/^#+\s*/, "") 
            };
        }
        else if (trimmed.startsWith(">")) {
            block = { type: "blockquote", startLine: adjustedLineNumber, content: trimmed.replace(/^>\s?/, "") };
        }
        else if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
            const match = trimmed.match(/^!\[(.*)\]\((.*)\)$/);
            block = { 
              type: "image", 
              startLine: adjustedLineNumber, 
              altText: match ? match[1] : "", 
              imageUrl: match ? match[2] : "" 
            };
        }
        else if (trimmed) {
            block = { type: "paragraph", startLine: adjustedLineNumber, content: trimmed };
        }
        if (block) {
            currentChunk.push(block);
        }
        if (currentChunk.length >= 50 || i === lines.length - 1) {
            chunks.push({ 
              chunk_id: currentChunkId, 
              start_line: currentStartLine, 
              end_line: adjustedLineNumber, 
              blocks: currentChunk 
            });
            currentChunk = [];
            currentChunkId++;
            currentStartLine = adjustedLineNumber + 1;
        }
    }
    return chunks;
}
window.parseMarkdownIntoChunks = parseMarkdownIntoChunks;

function restoreChunksFromCache(storedChunks) {
    if (!storedChunks || !storedChunks.chunks || storedChunks.chunks.length === 0) {
        console.log("🚫 No valid cached chunks found.");
        return;
    }
    console.log("✅ Restoring cached chunks...");
    const mainContentDiv = document.getElementById("main-content");
    storedChunks.chunks.forEach(chunk => {
        console.log(`🔄 Reinserting chunk ${chunk.id} from cache.`);
        const chunkElement = document.createElement("div");
        chunkElement.innerHTML = chunk.html;
        chunkElement.setAttribute("data-chunk-id", chunk.id);
        mainContentDiv.appendChild(chunkElement);
    });
    console.log("🔄 Manually triggering lazy loading after reinserting stored chunks.");
    initializeLazyLoadingFixed();
}
window.restoreChunksFromCache = restoreChunksFromCache;

window.cachedTimestamp = localStorage.getItem("markdownLastModified") || "null";
console.log("📂 Initial Cached Timestamp:", window.cachedTimestamp);

// ========= Markdown Loading =========


// ========= Lazy Loading / Sentinels =========


function getLastChunkElement() {
  const chunks = document.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return chunks[chunks.length - 1];
}

function loadPreviousChunkFixed(currentFirstChunkId) {
  const previousChunkId = currentFirstChunkId - 1;
  if (previousChunkId < 0) {
    console.warn("🚫 No previous chunks to load.");
    return;
  }
  if (document.querySelector(`[data-chunk-id="${previousChunkId}"]`)) {
    console.log(`✅ Previous chunk ${previousChunkId} is already loaded.`);
    return;
  }
  const prevChunk = window.nodeChunks.find(chunk => chunk.chunk_id === previousChunkId);
  if (!prevChunk) {
    console.warn(`❌ No data found for chunk ${previousChunkId}.`);
    return;
  }
  console.log(`🟢 Loading previous chunk (loadPreviousChunkFixed): ${previousChunkId}`);
  const scrollContainer = document.getElementById("main-content");
  const prevScrollTop = scrollContainer.scrollTop;
  const chunkWrapper = createChunkElement(prevChunk);
  scrollContainer.insertBefore(chunkWrapper, scrollContainer.firstElementChild);
  window.currentlyLoadedChunks.add(previousChunkId);
  const newChunkHeight = chunkWrapper.getBoundingClientRect().height;
  scrollContainer.scrollTop = prevScrollTop + newChunkHeight;
  if (window.topSentinel) {
    window.topSentinel.remove();
    scrollContainer.prepend(window.topSentinel);
  }
}

function loadNextChunkFixed(currentLastChunkId) {
  const nextChunkId = currentLastChunkId + 1;
  if (document.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
    console.log(`✅ Next chunk ${nextChunkId} is already loaded.`);
    return;
  }
  const nextChunk = window.nodeChunks.find(chunk => chunk.chunk_id === nextChunkId);
  if (!nextChunk) {
    console.warn(`❌ No data found for chunk ${nextChunkId}.`);
    return;
  }
  console.log(`🟢 Loading next chunk: ${nextChunkId}`);
  const mainContentDiv = document.getElementById("main-content");
  const chunkWrapper = createChunkElement(nextChunk);
  mainContentDiv.appendChild(chunkWrapper);
  window.currentlyLoadedChunks.add(nextChunkId);
  if (window.bottomSentinel) {
    window.bottomSentinel.remove();
    mainContentDiv.appendChild(window.bottomSentinel);
  }
}

function createChunkElement(chunk) {
    const chunkWrapper = document.createElement("div");
    chunkWrapper.setAttribute("data-chunk-id", chunk.chunk_id);
    chunkWrapper.classList.add("chunk");
    chunk.blocks.forEach(block => {
        const html = renderBlockToHtml(block);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        chunkWrapper.appendChild(tempDiv);
    });
    return chunkWrapper;
}

function getFirstChunkId() {
    const firstChunk = document.querySelector("[data-chunk-id]");
    return firstChunk ? parseInt(firstChunk.getAttribute("data-chunk-id"), 10) : null;
}

function getLastChunkId() {
    const chunks = document.querySelectorAll("[data-chunk-id]");
    if (chunks.length === 0) return null;
    return parseInt(chunks[chunks.length - 1].getAttribute("data-chunk-id"), 10);
}

function insertChunkInOrder(newChunk) {
    const mainContentDiv = document.getElementById("main-content");
    const existingChunks = [...mainContentDiv.querySelectorAll("[data-chunk-id]")];
    let inserted = false;
    const newChunkId = parseInt(newChunk.getAttribute("data-chunk-id"), 10);
    for (let i = 0; i < existingChunks.length; i++) {
        const existingChunkId = parseInt(existingChunks[i].getAttribute("data-chunk-id"), 10);
        if (newChunkId < existingChunkId) {
            mainContentDiv.insertBefore(newChunk, existingChunks[i]);
            inserted = true;
            break;
        }
    }
    if (!inserted) {
        mainContentDiv.appendChild(newChunk);
    }
    console.log(`✅ Inserted chunk ${newChunkId} in the correct order.`);
}

function loadChunk(chunkId, direction = "down") {
    console.log(`🟢 Loading chunk: ${chunkId}, direction: ${direction}`);
    if (!window.currentlyLoadedChunks) {
        window.currentlyLoadedChunks = new Set();
    }
    if (window.currentlyLoadedChunks.has(chunkId)) {
        console.log(`✅ Chunk ${chunkId} is already loaded. Skipping.`);
        return;
    }
    const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
    if (!chunk) {
        console.error(`❌ Chunk ${chunkId} not found!`);
        return;
    }
    const chunkWrapper = document.createElement("div");
    chunkWrapper.setAttribute("data-chunk-id", chunkId);
    chunkWrapper.classList.add("chunk");
    chunk.blocks.forEach(block => {
        if (!block.content) {
            console.warn(`🚨 Skipping empty block at line ${block.startLine}`);
            return;
        }
        const html = renderBlockToHtml(block);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        chunkWrapper.appendChild(tempDiv);
    });
    insertChunkInOrder(chunkWrapper);
    injectFootnotesForChunk(chunk.chunk_id, jsonPath);
    window.currentlyLoadedChunks.add(chunkId);
    console.log(`✅ Chunk ${chunkId} inserted.`);
}

async function reprocessMarkdown(newTimestamp) {
    console.log("⚠️ Reprocessing Markdown because of timestamp change...");
    try {
        let response = await fetch(`/markdown/${book}/main-text.md?v=${Date.now()}`);
        let markdown = await response.text();
        window.markdownContent = markdown;
        localStorage.setItem("cachedMarkdown", markdown);
        window.nodeChunks = parseMarkdownIntoChunks(window.markdownContent);
        console.log(`📏 New nodeChunks Size: ${(new Blob([JSON.stringify(window.nodeChunks)]).size / 1024).toFixed(2)} KB`);
        try {
            await saveNodeChunksToIndexedDB(window.nodeChunks);
            console.log("✅ New nodeChunks successfully saved in IndexedDB.");
        } catch (error) {
            console.error("❌ Failed to store new nodeChunks in IndexedDB:", error);
        }
        localStorage.setItem("markdownLastModified", newTimestamp);
        window.savedChunks = { timestamp: newTimestamp, chunks: [] };
        localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));
        initializePage();
    } catch (error) {
        console.error("❌ Error reprocessing Markdown:", error);
    }
}

function restoreChunksFromCache(storedChunks) {
    if (!storedChunks || !storedChunks.chunks || storedChunks.chunks.length === 0) {
        console.log("🚫 No valid cached chunks found.");
        return;
    }
    console.log("✅ Restoring cached chunks...");
    const mainContentDiv = document.getElementById("main-content");
    storedChunks.chunks.forEach(chunk => {
        console.log(`🔄 Reinserting chunk ${chunk.id} from cache.`);
        const chunkElement = document.createElement("div");
        chunkElement.innerHTML = chunk.html;
        chunkElement.setAttribute("data-chunk-id", chunk.id);
        mainContentDiv.appendChild(chunkElement);
    });
    console.log("🔄 Manually triggering lazy loading after reinserting stored chunks.");
    initializeLazyLoadingFixed();
}

window.restoreChunksFromCache = restoreChunksFromCache;


