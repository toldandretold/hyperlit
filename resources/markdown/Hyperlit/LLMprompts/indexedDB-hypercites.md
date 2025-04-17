I am about to start the implementation of my "hypercite" functionality. 

Previously, i had a system where citations were handled via a backend laravel based SQLite databse. 

Now, I am setting it up to work with indexedDB.

This should be reasonably straightforward, because I already do a similar thing with my highlights (hyperlights).

When text is highlighted/hypercited, the DOM is immediately changed.

With highlights, this is done by inserting Mark tags. With hypercites, a <u> tag will be added.

With highlights, a highlights object store in indexedDB is updated, and so to are the objects in the nodeChunks object store, for any affected html node.

I will paste here some of the relevant code for the existing highlight functionality. Then, I will explain what I need to do for the hyperlight version. 

For highlights, this funciton is called to update indexedDB:

```
async function addToHighlightsTable(highlightData) {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    
    // Create a document fragment to hold the highlighted content
    const fragment = document.createDocumentFragment();
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    // Clone the range contents to preserve HTML structure
    const clonedContents = range.cloneContents();
    fragment.appendChild(clonedContents);
    
    // Get the HTML content as a string, but remove any mark tags
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment.cloneNode(true));
    
    // Remove all mark tags from the temp div, preserving their content
    const markTags = tempDiv.querySelectorAll('mark');
    markTags.forEach(mark => {
      // Create a text node with the mark's content
      const textNode = document.createTextNode(mark.textContent);
      // Replace the mark with its text content
      mark.parentNode.replaceChild(textNode, mark);
    });
    
    const highlightedHTML = tempDiv.innerHTML;
    
    const highlightEntry = { 
      book: book, // Current book ID
      hyperlight_id: highlightData.highlightId,
      highlightedText: highlightData.text, // Keep the plain text for searching
      highlightedHTML: highlightedHTML, // Store the HTML structure without mark tags
      annotation: "", // initial empty annotation
      startChar: highlightData.startChar,
      endChar: highlightData.endChar,
      startLine: highlightData.startLine
    };

    const addRequest = store.add(highlightEntry);

    addRequest.onsuccess = () => {
      console.log("✅ Successfully added highlight to hyperlights table");
      resolve();
    };

    addRequest.onerror = (event) => {
      console.error("❌ Error adding highlight to hyperlights table:", event.target.error);
      reject(event.target.error);
    };
  });
}```


```addTouchAndClickListener(
  document.getElementById("copy-hyperlight"),
  async function() {
    // Existing code for selection and range checking
    let selection = window.getSelection();
    let range;
    try {
      range = selection.getRangeAt(0);
      console.log("📌 Full selected text:", selection.toString());
    } catch (error) {
      console.error("❌ Error getting range:", error);
      return;
    }

    let selectedText = selection.toString().trim();
    if (!selectedText) {
      console.error("⚠️ No valid text selected.");
      return;
    }

    // Get containers before any modifications
    let startContainer = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement.closest("p, blockquote, table, [id]")
      : range.startContainer.closest("p, blockquote, table, [id]");
    
    let endContainer = range.endContainer.nodeType === 3
      ? range.endContainer.parentElement.closest("p, blockquote, table, [id]")
      : range.endContainer.closest("p, blockquote, table, [id]");

    if (!startContainer || !endContainer) {
      console.error("❌ Could not determine start or end block.");
      return;
    }
    
    console.log("Start container:", startContainer);
    console.log("End container:", endContainer);
    
    // Calculate true character offsets before adding new marks
    const trueStartOffset = calculateTrueCharacterOffset(
      startContainer, 
      range.startContainer, 
      range.startOffset
    );
    
    const trueEndOffset = calculateTrueCharacterOffset(
      endContainer,
      range.endContainer,
      range.endOffset
    );

    console.log("True offsets:", { start: trueStartOffset, end: trueEndOffset });

    // Generate unique highlight ID
    const highlightId = generateHighlightID();

    // Apply the highlight
    highlighter.highlightSelection("highlight");
    modifyNewMarks(highlightId);

    // Find all nodes that contain marks with this highlightId
    const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodes = new Set();

    // Collect all unique container nodes that have our highlight
    affectedMarks.forEach(mark => {
      // Only look for specific container elements, not any element with an ID
      const container = mark.closest("p, h1, h2, h3, h4, h5, h6, blockquote, table");
      if (container && container.id) {
        affectedNodes.add(container);
      }
    });
    
    console.log("All affected nodes:", Array.from(affectedNodes).map(node => node.id));
    
    // Update all affected nodes in IndexedDB
    for (const node of affectedNodes) {
      const nodeId = parseInt(node.getAttribute("id"), 10);
      if (isNaN(nodeId)) continue;
      
      // Determine if this is start, middle, or end node
      let startOffset = 0;
      let endOffset = node.textContent.length;
      
      if (node === startContainer) {
        startOffset = trueStartOffset;
      }
      
      if (node === endContainer) {
        endOffset = trueEndOffset;
      }
      
      await updateNodeHighlight(node, startOffset, endOffset, highlightId);
      console.log(`Updated node ${node.id} with offsets:`, { start: startOffset, end: endOffset });
    }

    try {
      await addToHighlightsTable({
        highlightId: highlightId,
        text: selectedText,
        startChar: trueStartOffset,
        endChar: trueEndOffset,
        startLine: parseInt(startContainer.getAttribute("id"), 10)
      });
      console.log("Added to highlights table with data:", {
        highlightId: highlightId,
        text: selectedText,
        startChar: trueStartOffset,
        endChar: trueEndOffset
      });
    } catch (error) {
      console.error("❌ Error saving highlight metadata:", error);
    }

    attachMarkListeners();
  }
);
```


This updates the indexedDB. I will give two examples of what it looks like after a highlight is created:

the "hyperlights" object store is updated. 


It uses a [book, hyperlight_id] key. Here is ["nicholls2019moment", "unknown-user_1743643943315"] this has the following arrays:

```
book: "nicholls2019moment"

endChar: 5

highlightedHTML: "Mom"

highlightedText: "Mom"

hyperlight_id: "unknown-user_1743643943315"

```

## indexedDB: update hyperCited object store 
For the hypercites, we want to do the same, but by targetting the hypercites object store:


```
[book, hyperCited_ID] {

book: "nicholls2019moment"

endChar: 5

hypercitedHTML: "Mom"

hypercitedText: "Mom"

hypercite_id: "unknown-user_1743643943315"

relationshipStatus: "single"

citedIN: []


}
```

citedIN [] is initially null but can be filled with an array of citationIDs which have cited the same text. 

When the <u class="hypercited"> is clicked, a div will open and display content that is inserted by using the citationIDs found in this array. If there are no citationIDs there, the relationshipStatus will be "single". 

When its single, the hypercited <u> tag can link direclty to the passage where the text has been cited. [This is just an option...]

When a hyperCitedID is cited multiple times, its relationshipStatus: changes to "poly"

When it is poly, it **must** open the side div to display the different places the text has been cited. User can click any of these quotes to be taken to the location of that citation (where it was pasted). There, they can click back to the original source (where the text was copied).


## indexedDB: update nodeChunks object store

This uses a [book, startLine] key. startLine is a number that matches a specific html node id from the DOM.

Let's say a hypercite is created inside of <p id=1> in the book: example69thesis. This would trigger the update to the object: [example69thesis, 1], to record the details of the hypercited text:

```
nodeChunks: [book, startLine] {

   [

	hyperCited_Id: "unknown-user_1743643943315"
	charStart: 29
  charEnd: 33
  citedIN: [citationIDa#hyperCiteID, citationIDb#hyperCiteID]
  relationshipStatus: poly;

] 


}
```


The <u id="unknown-user_1743643943315" class="cited"> will be inserted at the charStart: 29, and the </u> at charEnd: 33. When clicked, this <u> tag will be made a button with javascript to open a side div that contains the content of each citedIN id... those stored in the hyperCited object store. 

# Process: the different stages of the hypercite process

Iniially, the DOM is altered to get 

<u id="hypercitedID" class="single"> hypercited text </u>

and the hyperCited object store, and nodeChunks are updated... 

but this is not a clickable link, as there has been no conformed citation paste event.

This is created after a listen/observe event notices that a copied hypercite has been pasted. When this happens, the pasted hypercite is used to extract the citationIDa#hypercitedID, which is used to call for a change to its record in indexedDB.

Most important is the change to the 


```
[book, hyperCited_ID] {

book: "nicholls2019moment"

endChar: 5

hypercitedHTML: "Mom"

hypercitedText: "Mom"

relationshipStatus: "single"

citedIN: []


}
```

it will have its relationShipStatus and citedIn arrays changed to:

```
relationshipStatus: "couple"

citedIN: [citationID#hyperciteID]
```

Such a hypercited text, if clicked, takes user straight to the url location of the hypercite, or where the text has been cited.


# overlapping citations

But what happens if a user goes to cite a part of the text that has already, even if only partially, been cited?

Initially, a new hypercite is created, as though there is no overlap...

a new hyperCitedID is created, with startChar and endChar as though there is no other <u> or <mark> or <span> tag in the node... 

It is added to nodeChunks and to hyperCited object store... 

But then, a function is called that checks if there are any overlapping startChar and endChar values between different hypercites

if there are... then they are amalgamated...

the hyperCitedID with the smallest startChar is used as a starting point.

inside its citedIN: [] array, is inserted all those hyperCitedIDs that overlap with it in that node. 

its endChar value is changed to be the highest endChar value in that node, of any hyperCitedID in teh citedIn array... 

That is, the lowest startChar and highest endChar of any of the overlapping hyperCitedIDs of a given node are used to merge all into one <u> tag, which has its class changed from singel, to couple, to poly, just as the relationshipStatus of the hyperCitedID changes like this too. 


--- 













These are used to get content from a 




so, i already do this for hyperlights/highlights.

I now just need to do it for hypercites. 

It could be that i develop some common functions to handle the commonalities... but it gets tricky as i will be doing slightly different updates in each function, so it might be better to just create them independently of each other... in anycase, it will need to be initialised within this function. we just want to focus on updating indexedDB for these two object stores as discussed, but for hypercites. Starting here:

```
function wrapSelectedTextInDOM(hyperciteId, book) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        console.error("No valid selection found for hypercite.");
        return;
    }
    const range = selection.getRangeAt(0);
    let parent = range.startContainer.parentElement;
    while (parent && !parent.hasAttribute('id')) {
        parent = parent.parentElement; // Traverse up to find a parent with an ID
    }
    if (!parent || isNaN(parseInt(parent.id, 10))) {
        console.error("No valid parent with numerical ID found.");
        return;
    }
    const wrapper = document.createElement('u');
    wrapper.setAttribute('id', hyperciteId);
    try {
        range.surroundContents(wrapper);
    } catch (e) {
        console.error("Error wrapping selected text:", e);
        return;
    }
    const blocks = collectHyperciteData(hyperciteId, wrapper);
    
    // sendHyperciteBlocksToBackend(book, hyperciteId, blocks); // this should be replaced with a function we need to write, such as NewHyperciteIndexedDB(book, hyperciteId, blocks);
    
    attachMarkListeners();
    setTimeout(() => selection.removeAllRanges(), 50);
} 
```


can you help with creating this new function: NewHyperciteIndexedDB(book, hyperciteId, blocks);, such that it will uupdate indexedDB as described?

---

# Receiving and connecting a hypercite

## So far: updated the COPY hypercite event in citationIDa

- indexedDB of the hypercited book (citationIDa: hyperciteID of copied text) is updated
- the cited text is copied as a hyperlit citation, in a format that can be recognised in any hyperlit text field, and which -- when pasted elsewhere, will link back to the originally-cited text. 

For example, some hypercited text is copied to clip board as:

```
"cited text" [[:]](http://127.0.0.1:8000/citationIDa#hyperciteID)
```
or
```
"Moment" [[:]](http://127.0.0.1:8000/nicholls2019moment#hypercite_6ay8e0m)
```

## Now, we must: update the PASTE hypercite event in citationID[b,c,d...] 

An event listener, or mutation observer, is activated when user presses the edit button. That is, when the div has its **contentEditable changed to true**... 

It starts listening/observing for paste events. When one is detected, the pasted text should be parsed, searching for any hypercite notation. 

That is, it listens for any: "[[:]](url)" strings in the content of a paste event. Or, any [:] within <a> tags that do not already have an id... 

If it detects one, it calls on the:

```
function hyperizeCitation(){



} 
```

this will itself call on two functions:

```
function generateUniqueHypercite();
function extractCitationIDa();
function findParent();
```

function generateUniqueHypercite() generates a hypercite called CitationB, and inserts it as an id into the pasted anchor.

This essentially changes the hypercite to:

"cited-text"<a id="citationB" href="citationIDa">[:]</a>

function findParent() uses the href of the pasted hypercite to make a change to the hypercite objectStoe of the originally cited text. That is, citationIDa. 

It looks in indexedDB for the object store of [book=citaitonIDa, hyperciteIDa], it updates its contents to change it from (for example):

```
charEnd: 8

charStart: 2

hyperciteId: "hypercite_6ay8e0m"

pastedNodes: [] (0)

relationshipStatus: "single"
```

to (for example):

```
charEnd: 8

charStart: 2

hyperciteId: "hypercite_6ay8e0m"

pastedNodes: [citationIDa] (1)

relationshipStatus: "connected"
```

## Question for LLM:

```
If the book of the originally cited text is open, how can we get it to refresh the affected nodes by re-calling them from their recently updated nodeChunks?
```

---

# Overlapping Hypercites

In lazyLoaderFactory, when going to insert hypercites from the indexedDB data... if there are multiple hypercites for a single node, it must check to see if they are overlapping startChar and endChar, for the different citations. If they do overlap, then their <u> tags are **not** inserted. Instead, the smallest startChar and the largest endChar are used to insert a collective <u> tag. for example:

```
<u id="multipleCitations_666">
```

This new collective citation should be added to the hypercites object store in indexedDB, so that it can be inserted by lazyLoaderFactory... 

There, it contains these fields

```
book: "nicholls2019moment"

startChar: 2
endChar: 8

hypercite_id: "multipleCitations_666"

hypercitedHTML: "Moment"

hypercitedText: "Moment"

relationshipStatus: "poly"

pastedNodes: [hyperciteIDb, hyperciteIDc, hyperciteIDd] (3)


```

it also updates the hypercite data for the pastedNodes, changing:

```

relationshipStatus: "single"
```

to 

```
polyculeNode: [multipleCitations_666] (2)

relationshipStatus: "poly"
```

This is useful for next time, so that the lazyLoaderFactory can simply insert the 

```
<u id="multipleCitations_666" class="poly">
```

This is useful, as then our javascript, which treats these <u class="poly"> nodes as buttons, calls a 

```
function onCLick(); /* (i guess?) */
```
which pulls in the highlightDiv..., and loads content from the hypercite object store in indexedDB 

it does this by getting the pastedNodes from the hypercites object store for the collective hypercite hypercite_ID


```
book: "nicholls2019moment"

startChar: 2
endChar: 8

hypercite_id: "multipleCitations_666"

hypercitedHTML: "Moment"

hypercitedText: "Moment"

relationshipStatus: "poly"

pastedNodes: [hyperciteIDb, hyperciteIDc, hyperciteIDd] (3)


```


it pulls the data from each citationID in pastedNodes, it can print:

```

<a href="url.com/citationIDa#hyperciteIDa"><u>cited text</u></a> [: Author, Title, Publisher, Year.]

---

<a href="url.com/citationIDa#hyperciteIDa"><u>cited text</u></a> [: Author, Title, Publisher, Year.]


```

In this way, when citations overlap, their **citedBY underline tags** open a side div, which prints their cited texts, as direct links to their pasted texts, followed by their corresponding **traditional academic citation**.

Thus, when user presses a hypercite, it opens a hypercite side div, which includes the hypercited content of whatever hypercite ids are associated with that <u> tag. 









 




















is called. it: 1. generates a new hyperciteID, and applies it to the pasted link. for example: "extracts from the url of the pasted 


























