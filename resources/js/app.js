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
window.jsonPath = `/markdown/${window.book}/main-text-footnotes.json`;
window.mdFilePath = `/markdown/${window.book}/main-text.md`;  // Path to raw MD file

window.isNavigatingToInternalId = false;

// Function to attach listeners to <mark> tags
    // Function to attach listeners to <mark> tags
function attachMarkListeners() {
    // Select all <mark> tags that have an ID.
    const markTags = document.querySelectorAll("mark[id]");
    
    markTags.forEach(function (mark) {
        // Remove existing listeners to avoid duplication
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);

        // Add event listeners
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);

        // Mark the <mark> tag as having a listener attached
        mark.dataset.listenerAttached = true;
    });

    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags.`);
}

window.attachMarkListeners = attachMarkListeners;   

function handleMarkClick(event) {
    event.preventDefault(); // Prevent default link behavior
    const highlightId = event.target.id;
    console.log(`Mark clicked: ${highlightId}`);
    // Navigate to the highlight – adjust the URL as needed.
    window.location.href = `/${window.book}/hyperlights#${highlightId}`;
}
window.handleMarkClick = handleMarkClick;

function handleMarkHover(event) {
    event.target.style.textDecoration = "underline"; // Add underline on hover
}

window.handleMarkHover = handleMarkHover;

function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none"; // Remove underline on hover out
}

window.handleMarkHoverOut = handleMarkHoverOut;

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

// Expose the function globally, if needed
window.scrollElementIntoMainContent = scrollElementIntoMainContent;

function lockScrollToTarget(targetElement, headerOffset = 50, attempts = 3) {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) {
      clearInterval(interval);
    }
  }, 300);
}

window.lockScrollToTarget = lockScrollToTarget;

