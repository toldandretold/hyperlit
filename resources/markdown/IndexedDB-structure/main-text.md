IndexedDB Structure

## macro units

1. DOM - can be saved to indexedDB per <div data-chunk-id="">, after visible data-chunk-id is updated. 

This is done so that, if user returns to browser and DOM has not been cached, dont' need to re-initialize lazy loading, or load from nodeChunks, can just insert the last visible data-chunk-id as pre-rendered html, and then begin listening for sentinels etc. 

2. IndexedDB parses nodeChunks.json into structured data storage so that IndexedDB can be updated on a line-by-line basis on front end. This means that front end creates the time-stamp, and sends this to back-end. And this means that page-refreshing should be minimal and users can work offline. 
	
nodeChunks.json is initially created by parseing main-text.md into chunks, nodes, line-numbers, md-content, hyperlights, and hypercites. 

The hyperlights and hypercites store the hyperlight_ids and hypercite_ids of the md content.

These ideas refer to, or are links other indexedDB databases: hyperlights and hyperictes. 

There, each hyperlight and hypercite has the start-line-number, end-line-number, character-count start, and character-count end. 

# updating IndexedDB 

## macro workflow of front-end to back-end

If the indexedDB is intialised correctly, any highlight or hypercite that is added or removed can trigger an update of the IndexedDB, on the front end.

When a certain time has elapsed after the indexedDB has been updated, the changs will be batched and sent to back-end, along with a time-stamp, from the front end. 

Thus, the back-end is mostly used for saving the .json files, according to the front end. The **advantage of this** is that, on page load, the timestamps should rarely not match, and so the user should only need a hard re-load when moving to a diff browser, or when they have edited their md files locally on a plain text editor like obsidian. 

## micro workflow on front-end

### Adjusting line-number on update

IndexedDB needs to be initialised such that the line-number value of each md-content (stored by line), is automatically updated when a new line/html-node is inserted or deleted. 

This can happen because all html nodes in the Dom receive an id that matches the md line number initially given in nodeChunks.json, and stored in the IndexedDB structure.

So, say user inserts a new html paragraph between html-nodes 17 and 18, that needs to insert in the indexedDB database between these entries, and re-number by one all those following it. 

If one is deleted, all those following need to have that number reduced by one. 


### adjusting character counts on update

A similar function needs to take place when content is changed within a line. This is for hyperlights and hypercites. So, lets say that we have a hyperlight with start-value of (5, 3). This represents line 5 and character 3. and an end-value of (6, 5), which represents line 6 and character 5.

If user deletes characters before the highlight, say character (5,1), then the start-value of the highlight needs to be reduced to (5,2). if characters within the highlight are changed, then the end-value may need to be changed. 



exmaple of structure:

{
  url: "https://example.com",
  container: "main",
  book: "book1",
  lineNumber: 50,  // This indicates the start line for this record
  chunk_id: 1,
  blocks: [
    {
      type: "paragraph",
      content: "Some markdown content for this line",
      startLine: 50,
    }
  ],
  hyperlights: [
    {
      hyperlight_id: "hl-1234",
      Start: yes/no,
      Middle: yes/no,
      End: yes/no 
    }
  ],
  hypercites: [
    {
      hyperlight_id: "hl-1234",
      Start: yes/no,
      Middle: yes/no,
      End: yes/no 
    }
  ],
  footnotes: [
    {
      md: "[^66]",
      content: "The content to be displayed."
    }
  ]
}


