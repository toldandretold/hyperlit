let insertedLetters = {}; // Track lettered inserts for each base ID

mainContentDiv.addEventListener("beforeinput", function (e) {
    if (e.inputType === "insertParagraph") {
        setTimeout(assignLetteredIdsToDuplicateParagraphs, 0);
    }
});

mainContentDiv.addEventListener("input", function (e) {
    if (e.inputType === "insertParagraph" || e.inputType === "insertText") {
        setTimeout(assignLetteredIdsToDuplicateParagraphs, 0);
    }
});

// Function to find and fix duplicate IDs
function assignLetteredIdsToDuplicateParagraphs() {
    const allParagraphs = mainContentDiv.querySelectorAll("p");
    const seenIds = new Set();

    allParagraphs.forEach((p, index, paragraphs) => {
        let currentId = p.id;

        // If the ID is a duplicate or already seen
        if (seenIds.has(currentId)) {
            const precedingParagraph = paragraphs[index - 1];

            if (precedingParagraph && precedingParagraph.id) {
                const baseIdMatch = precedingParagraph.id.match(/^(\d+_\d+)([a-z]*)$/);
                if (baseIdMatch) {
                    // Blockquote paragraph: Use base subnumber and append letter
                    const baseSubId = baseIdMatch[1]; // e.g., "7_7"
                    const nextLetter = getNextLetter(baseSubId);
                    p.id = `${baseSubId}${nextLetter}`;
                    console.log(`Assigned new blockquote paragraph ID: ${p.id}`);
                } else {
                    // Standalone paragraph: Default to lettered IDs
                    const baseId = precedingParagraph.id.match(/^(\d+)/)[1];
                    const newLetter = getNextLetter(baseId);
                    p.id = `${baseId}${newLetter}`;
                    console.log(`Assigned new standalone paragraph ID: ${p.id}`);
                }
            }
        }

        seenIds.add(p.id);
    });
}

// Helper: Get the next letter for a given base ID or base subnumber
function getNextLetter(baseId) {
    if (!insertedLetters[baseId]) {
        insertedLetters[baseId] = "a";
    } else {
        let letter = insertedLetters[baseId];
        letter = String.fromCharCode(letter.charCodeAt(0) + 1); // Increment letter
        insertedLetters[baseId] = letter;
    }
    return insertedLetters[baseId];
}


// Initialize tracker on page load
function initializeInsertedLetters() {
    const allParagraphs = mainContentDiv.querySelectorAll("p");
    allParagraphs.forEach((p) => {
        const baseIdMatch = p.id.match(/^(\d+_\d+)([a-z]*)$/);
        if (baseIdMatch) {
            const baseSubId = baseIdMatch[1];
            const letter = baseIdMatch[2];
            if (letter) {
                if (!insertedLetters[baseSubId] || letter > insertedLetters[baseSubId]) {
                    insertedLetters[baseSubId] = letter; // Track the largest letter for the baseSubId
                }
            }
        }
    });
    console.log("Initialized inserted letters:", insertedLetters);
}

initializeInsertedLetters();



const modifiedNodes = new Set(); // Track modified nodes
const deletedNodes = new Set(); // Track deleted nodes

document.addEventListener("click", (e) => {
    if (e.target && e.target.classList.contains("delete-button")) {
        const parentId = e.target.closest("[id]").id; // Get the ID of the parent container
        if (parentId) {
            deletedNodes.add(parentId);
            console.log(`Node with ID ${parentId} added to deletedNodes.`);
        }
    }
});

// Observe changes only for text content modifications
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.type === "characterData") {
            const parent = mutation.target.parentElement;
            if (parent && parent.id) {
                modifiedNodes.add(parent.id); // Track text changes only
                console.log(`Node with ID ${parent.id} marked as modified.`);
            }
        }
    });
});

// Restrict observation to text nodes
observer.observe(mainContentDiv, { childList: false, subtree: true, characterData: true });

console.log("MutationObserver configured to observe text changes only.");

// Save button handler
document.getElementById("saveButton").addEventListener("click", async () => {
    console.log("Save button clicked");

    // Log current contents of deletedNodes and modifiedNodes
    console.log("Current deletedNodes:", Array.from(deletedNodes));
    console.log("Current modifiedNodes:", Array.from(modifiedNodes));


    const updates = [];

    // Prepare modified nodes for update
    modifiedNodes.forEach((id) => {
        const node = document.getElementById(id);
        if (node) {
            updates.push({
                id,
                html: node.outerHTML,
                action: "update",
            });
        }
    });

    // Prepare deleted nodes for deletion
    deletedNodes.forEach((id) => {
        updates.push({
            id,
            action: "delete",
        });
    });

    console.log("Prepared updates for backend:", updates);

    if (updates.length === 0) {
        console.log("No changes detected.");
        return;
    }

    try {
        const response = await fetch("/save-div-content", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document
                    .querySelector('meta[name="csrf-token"]')
                    .getAttribute("content"),
            },
            body: JSON.stringify({ book: book, updates }),
        });

        if (response.ok) {
            console.log("Changes saved successfully.");
            modifiedNodes.clear();
            deletedNodes.clear();
        } else {
            console.error("Failed to save changes.");
        }
    } catch (error) {
        console.error("Error:", error);
    }
});



// Hyperlink processing function
async function processHyperCiteLinks(book, updatedNodes) {
    if (!updatedNodes.length) {
        console.log("No updated nodes to process for hyperlinks.");
        return;
    }

    for (const { id, html } of updatedNodes) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = doc.querySelectorAll('a');

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (anchor && anchor.textContent.includes('[:]') && href && !anchor.hasAttribute('id')) {
                try {
                    const response = await fetch(`/process-hypercite-link`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                        },
                        body: JSON.stringify({ href_a: href, citation_id_b: book })
                    });

                    const data = await response.json();
                    if (data.success) {
                        console.log(`New hypercite ID assigned: ${data.new_hypercite_id_x}`);
                        anchor.setAttribute('id', data.new_hypercite_id_x);
                    } else {
                        console.log(`Skipped hyperlink: ${href}`, data.message);
                    }
                } catch (error) {
                    console.error("Error processing hyperlink:", error);
                }
            }
        }
    }

    console.log("Hyperlink processing completed.");
    }


    document.getElementById('markdown-link').addEventListener('click', function () {
        window.location.href = `/${book}/md`;
    });

    document.getElementById('readButton').addEventListener('click', function () {
        localStorage.setItem('fromEditPage', 'true');
        window.location.href = `/${book}`;
    });
