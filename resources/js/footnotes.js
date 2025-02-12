
// footnotes buttons
// footnotes.js
export const refContainer = document.getElementById("ref-container");
export const refOverlay = document.getElementById("ref-overlay");
export let isRefOpen = false;

async function injectFootnotesForChunk(chunkId) {
  // Temporarily disable lazy loading
  window.isUpdatingJsonContent = true;
  console.log("⏳ Disabling lazy loading while updating footnotes...");

  // Look up the chunk data by chunkId.
  const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
  if (!chunk) {
    console.error(`❌ Chunk with ID ${chunkId} not found.`);
    window.isUpdatingJsonContent = false;
    return;
  }

  // Use the chunk’s start and end line numbers.
  const startLine = chunk.start_line;
  const endLine = chunk.end_line;

  try {
    // ✅ Check memory cache first
    let sections = window.footnotesData;

    // ✅ Try IndexedDB if missing
    if (!sections) {
      console.log("⚠️ No footnotes in memory, checking IndexedDB...");
      sections = await getFootnotesFromIndexedDB();
    }

    // ✅ Fetch from the server if still missing
    if (!sections) {
      console.log("🌍 Fetching footnotes from server...");

      // Get last stored timestamp (or default to 0)
      const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";
      
      // Construct URL with timestamp to avoid cache issues
      const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
      console.log(`🔗 Fetching footnotes from: ${freshJsonUrl}`);

      const response = await fetch(freshJsonUrl);
      sections = await response.json();
      
      // ✅ Save fetched footnotes to IndexedDB for future use
      await saveFootnotesToIndexedDB(sections);
      
      // ✅ Cache in memory for immediate access
      window.footnotesData = sections;
    }

    // ✅ Now we have the footnotes in `sections`
    console.log("✅ Footnotes data loaded, injecting footnotes...");

    sections.forEach((section) => {
      if (section.footnotes) {
        Object.entries(section.footnotes).forEach(([key, footnote]) => {
          const { line_number, content } = footnote;

          // Process only if the footnote’s line number is within this chunk’s range.
          if (line_number >= startLine && line_number <= endLine) {
            const targetElement = document.getElementById(line_number.toString());
            if (targetElement) {
              // Avoid duplicate injection.
              if (targetElement.innerHTML.includes(`<sup class="note" data-note-key="${key}">`)) {
                console.log(`Footnote ${key} already processed in chunk ${chunkId}. Skipping.`);
                return;
              }

              // Construct a regex to find the Markdown footnote reference.
              const regex = new RegExp(`\\[\\^${key}\\](?!:)`, "g");
              if (regex.test(targetElement.innerHTML)) {
                // Convert Markdown footnote content to HTML.
                const footnoteHtml = content ? convertMarkdownToHtml(content) : "";

                // Replace the Markdown footnote marker with a <sup> element.
                targetElement.innerHTML = targetElement.innerHTML.replace(
                  regex,
                  `<sup class="note" data-note-key="${key}">[^${key}]</sup>`
                );
              } else {
                console.warn(`Regex did not match for footnote key: ${key} in element:`, targetElement.innerHTML);
              }
            } else {
              console.warn(`No target element found for line_number: ${line_number} in chunk ${chunkId}`);
            }
          }
        });
      }
    });

    // ✅ Re-enable lazy loading after footnotes update
    setTimeout(() => {
      window.isUpdatingJsonContent = false;
      console.log("✅ Re-enabling lazy loading after footnotes update.");
    }, 200); // Delay ensures any layout shifts settle

  } catch (error) {
    console.error("❌ Error injecting footnotes for chunk:", error);
    window.isUpdatingJsonContent = false;
  }
}

window.injectFootnotesForChunk = injectFootnotesForChunk;



// Function to update the footnotes container state
function updateRefState() {
        if (isRefOpen) {
        console.log("Opening footnotes container...");
        refContainer.classList.add("open");
        refOverlay.classList.add("active");
        } else {
          console.log("Closing footnotes container...");
          refContainer.classList.remove("open");
          refOverlay.classList.remove("active");
          }
}

window.updateRefState = updateRefState;


// Function to fetch footnotes from memory, IndexedDB, or server
async function fetchFootnotes() {
    try {
        // ✅ 1. Check if footnotes are already loaded in memory
        if (window.footnotesData) {
            console.log("✅ Using cached footnotes from memory.");
            return window.footnotesData;
        }

        // ✅ 2. Try to load footnotes from IndexedDB
        console.log("⚠️ No footnotes in memory, checking IndexedDB...");
        let footnotes = await getFootnotesFromIndexedDB();
        if (footnotes) {
            console.log("✅ Loaded footnotes from IndexedDB.");
            window.footnotesData = footnotes; // Cache in memory for next time
            return footnotes;
        }

        // ✅ 3. Fetch footnotes from the server as a last resort
        console.log("🌍 Fetching footnotes from server...");

        // Get last stored timestamp (or default to 0)
        const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";

        // Construct URL with timestamp to bypass cache
        const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
        console.log(`🔗 Fetching footnotes from: ${freshJsonUrl}`);

        const response = await fetch(freshJsonUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch footnotes JSON: ${response.statusText}`);
        }

        // ✅ Parse footnotes JSON
        footnotes = await response.json();

        // ✅ Store fetched footnotes in IndexedDB for future use
        await saveFootnotesToIndexedDB(footnotes);

        // ✅ Cache footnotes in memory for fast access
        window.footnotesData = footnotes;

        console.log("✅ Successfully fetched and stored footnotes.");
        return footnotes;
    } catch (error) {
        console.error("❌ Error fetching footnotes JSON:", error);
        return null;
    }
}

window.fetchFootnotes = fetchFootnotes;


// Function to open the footnotes container with content
function openReferenceContainer(content) {
      console.log("Opening reference container with content:", content); // Debugging output
      if (refContainer) {
        if (refContainer) {
            refContainer.innerHTML = content; // Populate the container
            isRefOpen = true;
            updateRefState();
            }
        }
}

window.openReferenceContainer = openReferenceContainer;

// Function to close the reference container
function closeReferenceContainer() {
        isRefOpen = false;
        updateRefState();
          setTimeout(() => {
              refContainer.innerHTML = ""; // Clear content after animation
          }, 300); // Delay to match the slide-out animation
}

window.closeReferenceContainer = closeReferenceContainer;

  console.log("convertMarkdownToHtml function:", typeof convertMarkdownToHtml);

async function displayFootnote(noteElement) {
                const noteKey = noteElement.dataset.noteKey;
                const parentId = noteElement.closest("[id]")?.id;

                console.log("Note key:", noteKey);
                console.log("Parent ID:", parentId);


                if (!noteKey || !parentId) {
                    console.warn("Missing note key or parent ID for the clicked footnote.");
                    return;
                }

                const footnotesData = await fetchFootnotes();
                if (!footnotesData) {
                    console.error("Footnotes data could not be fetched.");
                    return;
                }

                console.log("Fetched footnotes data:", footnotesData);

                // Locate the correct section and footnote
                const section = footnotesData.find((sec) =>
                    Object.values(sec.footnotes || {}).some(
                        (footnote) => footnote.line_number.toString() === parentId && footnote.content
                    )
                );

                console.log("Matched section:", section);

                if (!section) {
                    console.warn(`No matching section found for line ${parentId}.`);
                    return;
                }

                const footnote = section.footnotes[noteKey];
                console.log("Matched footnote:", footnote);

                if (!footnote || footnote.line_number.toString() !== parentId) {
                    console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
                    return;
                }

                console.log("Footnote content before conversion:", footnote.content);
                // Convert the Markdown content to HTML
                const footnoteHtml = convertMarkdownToHtml(footnote.content);
                console.log("Converted HTML:", footnoteHtml);

                // Display the content in the reference container
                console.log("Opening reference container with content:", `<div class="footnote-content">${footnoteHtml}</div>`);
                openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
}

window.displayFootnote = displayFootnote;
