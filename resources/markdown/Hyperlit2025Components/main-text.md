Components  -----------







The **import form** should be its own component, isolated from other event listeners, and so on. It would automatically not assume the same event listeners, like Copy and Paste, that occur elsewhere. Simply because I don't have the time, and -- let's be honest -- skills, I am going to rely on (https://vuejs.org)\[Vue.\].... please, what is the best way for me to go about this? Currently, my logic for this is stored within newBookForm.js. How can I refactor this into an isolated component? That is, in terms of the state of event listeners, and so on.

I have already done something _like_ this using Vanilla JS  for the Hypertext Editor, which is initialised within

  
 As it is initialised as an instance within









    <main class="main-content" id="CitationID" contenteditable="true"> ... </main>









This "component" imports chunks of html nodes from the nodeChunks object store in the browser's IndexedDB. Each html parent node within <main> has a numerically ascending ID. For example, each <p>aragraph , heading (<h1>, <h2>, et al.), <blockquote>, <code>, and <table>, tag is given an ID that is a _number_ (data-type: float), that starts at 1, and ascends all the way down until the end of <main>.

However, within the browser, the state of <main> changes as the user scrolls. <main> only imports some of the nodes from the nodeChunks object store at a given time. Nodes are imported as chunks of 100, data on which is stored as the chunk\_id within the object. Here is an example of this objects node (on Sunday 25 May, 2025):

    [Hyperlit2025Components, 18.1]: {  ​​book: "Hyperlit2025Components"  chunk_id: 0  content: "<p id=\"18.1\">However, within the browser, the state of &lt;main&gt; changes as the user scrolls. &lt;main&gt; only imports some of th…"  hypercites: [] (0)  hyperlights: [] (0)  startLine: 18.1​​​​​}​

The startLine value shows that it s the 18.1st node for Hyperlit2025Components. Hence, it is <p id="18/1">...</p>.

It is in the first chunk of 100 nodes. Hence it is chunk\_id: 0. On page load (reader-DOMcontentLoaded.js), it is injected into <main> within a <div> with class="chunk", and data-chunk-id="0":

    <div data-chunk-id="0" class="chunk"></div>

There, the first 100 parent-nodes are inserted. For the other chunk divs to be loaded, user must have scrolled down far enough for the **window?** to have detected a sentinel div. There is one at the very top and very bottom of main, which all chunk divs are loaded into. In this case:

    <main id="Hyperlit2025Components" class="main-content" contenteditable="true>​​​  <div id="Hyperlit2025Components-top-sentinel"   ​class="sentinel">​  </div>​    <div data-chunk-id="0">       <h1 id="1">Components</h1>​​       <p id="2">The import form should...</p>       ...    </div>​​    <div data-chunk-id="1">    ...    </div>​​​​  <div id="Hyperlit2025Components-bottom-sentinel"   ​class="sentinel">​​  </div></main>​











