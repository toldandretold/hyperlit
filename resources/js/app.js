
// resources/js/app.js
console.log('App.js is loaded');

let book = document.getElementById('main-content').getAttribute('data-book');
window.book = book;

const mainContentDiv = document.getElementById("main-content"); // This already exists
window.mainContentDiv = mainContentDiv;





// Function to attach listeners to <mark> tags
    // Function to attach listeners to <mark> tags
function attachMarkListeners() {
    // Select all <mark> tags, including those with `data-listener-attached`
    const markTags = document.querySelectorAll("mark");

    markTags.forEach(function (mark) {
        const highlightId = mark.getAttribute("id");

        if (highlightId) {
            // Remove existing listeners to avoid duplication
            mark.removeEventListener("click", handleMarkClick);
            mark.removeEventListener("mouseover", handleMarkHover);
            mark.removeEventListener("mouseout", handleMarkHoverOut);

            // Add click event listener to navigate to the highlight
            mark.addEventListener("click", handleMarkClick);

            // Add hover effect for underline
            mark.addEventListener("mouseover", handleMarkHover);
            mark.addEventListener("mouseout", handleMarkHoverOut);

            // Mark the <mark> tag as having a listener attached
            mark.dataset.listenerAttached = true;
        }
    });

    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags.`);
}
// Attach functions to window
window.attachMarkListeners = attachMarkListeners;   

// Click handler for <mark> tags
function handleMarkClick(event) {
    event.preventDefault(); // Prevent default link behavior
    const highlightId = event.target.id;
    console.log(`Mark clicked: ${highlightId}`);
    window.location.href = `/${book}/hyperlights#${highlightId}`;
}

// Hover handlers for <mark> tags
function handleMarkHover(event) {
    event.target.style.textDecoration = "underline"; // Add underline on hover
}

function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none"; // Remove underline on hover out
}
