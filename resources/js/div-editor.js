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
