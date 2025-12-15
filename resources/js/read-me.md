# A cyclical markdown processor for the web.

By processor, there are two meanings. Process as in a "food processor". The markdown content can be altered/processed by user input and/or automated adjustments. 

But its also a process, meaning a series of steps, and this process is cyclical.

The idea for this web page is that a user can enter that process at any point and it will still function.

So, if a user creates a new folder '/foldername' in their "vault", and it contains "main-text.md", then they can navigate to: hyperlit.io/foldername and the main-text.md will be loaded into the page.

When a main-text.md is loaded into the page, the loadMarkdownFile(); function checks whether:

nodes.json exists in the indexedDB of browser, and if it is the most updated one. if it isn't, it checks if one exists in the /foldername. if it doesn't, it generates one, and saves it to indexedDB and in the /foldername (via backend MainTextEditableDivController).

The nodes.json is the md file sorted into chunks of nodes, each chunk is lazy loaded (see lazy-loading.js). 

This ensures that even if the main-text.md is a massive book, like The Bible, it will still be loaded reasonably well. 

Then, whenever user adds a highlight hyper-cite, the back end updates the relevant databses, the nodes.json, and the latest_update.json.

Thus, with this system, it doesn't matter how "processed" the markdown is. It will get processed when the processing is needed. 

Whenever any action in the cycle of processing takes place, the relevent processing is triggered. It is done so as to reduce data storage and load times, and to provide users with the control over their own data. As this is all saved to **the author's** folder.

To take another example, imagine that instead of just manually adding a /folder-name and main-text.md, the user adds a new page via /cite-controller. This allows users to convert a word doc to md. When doing so a main-text-footnotes.json is created, which is used for table of contents and footnotes... 

but these things are also created whenver a user saves the file. so they can manually enter md footnotes.[^1]

This cycle continues forever, and in each moment of the cycle, the idea is for the quickest mechanism to process the relevant md giving user the maximum control of their own content, while also allowing for advanced collaborative online features. 

[^1]: Like, whenever they want. 


