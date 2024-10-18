# inner-file compiling #

1. Go through each file in the text folder of the decompressed epub and remove the <html> tags at the start.  That is, all tags up to and including  the body tag. For example:

"<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>The Global Architecture of Multilateral Development Banks</title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <link rel="stylesheet" type="text/css" href="../stylesheet.css"/>
<link rel="stylesheet" type="text/css" href="../page_styles.css"/>
</head>
  <body class="calibre">
<div class="calibre1">
<div class="calibre1">"

	inner content

</div>
</div>
</body>
</html>

As can see from the example, the begining html, and hte ending html is removed. that is, tags like body, html, and these two parent div tags, which house the internal content, should all be removed. 

However, html content between these parent tags should not be removed. For example:

"<h2 class="item5">4.2 The Post-Washington Consensus era: 1998–2009</h2>

<div class="item">
        The post-Washington Consensus era began following the Asian Financial Crisis and it saw a large shift in the
        global aid agenda with a big push for debt forgiveness and poverty reduction resulting in increasing the
        concessional resources available to developing countries and developing country ownership of development
        pathways through the Aid Effectiveness Agenda. Politically, the shift built on the rise of large progressive
        social movements and centre left parties like those of <a class="item2"></a>Bill Clinton in the US (1993–2001)
        and Tony Blair in the UK (1997–2007), whose minimally progressive agendas were friendly to globalisation
        (Mawdsley et al. 2018). Large social movements included the <a class="item2"></a>anti-globalisation movement
        peaking in the <a class="item2"></a>Battle for Seattle in 1999, the landmark protests in Cochabamba, Bolivia
        against <a class="item2"></a>privatised water price hikes in 2000, and the <a class="item2"></a>Make Poverty
        History coalition. Economically, the growth of China and relative stability globally meant many developing
        regions started to emerge from the austerity-induced recessions of the 1980s and early 1990s. It is a mistake,
        however, to think that there were no crashes: Brazil in 1999, the dotcom bubble burst of 2000, and Argentina in
        2001 were three of the largest and the pre-conditions for the next regional debt crisis began with the build-up
        of private sector debt in the US and Europe, leading to the GFC.
      </div>

 <div class="item1">
        Ideationally, the MDBs drew mostly on the New Institutional Economics (NIE) strand of mainstream economics. NIE
        was an attempt to build on neoclassical economics by incorporating a theory of institutions (North 1998). By
        significantly expanding neoclassical analysis of market failures to include information failures and
        transaction costs, NIE produced a picture of markets as subject to extensive imperfections, in contrast to the
        neoliberal idea of perfectly functioning markets (Fine 2001, 2005). As Greenwald and Stiglitz (1986) outlined,
        this means that government intervention could be efficient in many more cases than neoliberal doctrine allowed.
        Stiglitz was World Bank Chief Economist from 1997 to 2002 but was fired for his somewhat unorthodox views,
        though his influence lived on. His review of neoliberal ‘big bang’ capital market liberalisation concluded that
        if attention was not given to the order and timing of reform, programmes can cause more harm than good (Broad
        2004, Stiglitz 2002).
      </div>"

2. insert a <br> tag at the bottom of each file. 

3. These files should be saved seperately, within a folder caled "parsed_html", so that the origianl files are preserved.


5. Using the TOC.ncx file as a guide to establish the correct order of files, compile the contents of each file into a single main-text.html file.

4. Parse through the main-text.html file, looking for any internal link. That is, any link that features a "#" used to link to a unique ID. If there is text before the "#", then that text should be removed. For example, if a link was href="ch_6.html#ref77", it should be changed to href="#ref77". 










# Link parsing #

Need to search for all internal hyperlinks, and caterise them. The first question is, are they one directional, or two-way links.

That is, if the link takes the user to a part of the epub, whether in the same file or a diff file, and that location links back to the origianl link.

Determining if it is a one or two way link is tricky, because the back-link might not link to the origianl <a> tag, but to an id in a <sup> or <div>. Thus, when a link is found, we need to search around it for any ID associated either with the <a>, or a <div> that it is in, or a <sup> that is within the <a> tag. 

Then, we need to go to the ID that the <a> links to. Does this tag have near it a link back to the ID associated or promiximate to the first link? 

If [YES], then these two links can be paired and categorised as a two way link. See the steps below for further categorisation for [two-way links](#two-way-internal-links).

If [NO], then we need to further categorise it. 

Does it feature a <sup> tag? 

Does the destination exist within what appears like an ordered list of other IDs, or a sequence of <div> tags that share a common pattern? 

If [YES]: 

- is this sequence in its own file, or at the end of a file? 
- is this sequence at the start or end of epub according to TOC.ncx?

This information is useful for determing:

- is the link to a table of contents (at the beginning of the file)
	- these links would NOT have a <sup> tag
- is the link to footnotes
	- these would most likely have a <sup> tag, and would link to a set of IDs that are either at the bottom of a page, or in a page near the end of the epub according to the TOC.ncx


# Two-Way Internal Links #

Two-way internal links (whether to a diff page or not), must include:

- An ID for the start, and an ID for the end.

The end poing must also include:

- Its own ID, and the ID for the return.


This is difficult to determine because: these IDs may not be in the <a> tag. They could be in a <div>, <sup>, or even an <em> tag. However, these two IDs must be in the same general area.

What I need to do is pass through all the files of an epub looking for the IDs that are associated with each two-way link. 

These two-way links need to be further categorised. For example, are these two way links:

- within the same page [or] between different pages. 

## For those two-way links that are in the same page ##

We need to sort between the start (a) and end (b) links. That is, which link comes first (a) in the page, and which comes second (b). 

Once this is done, we need to assess: 

- are the (a) links all in a sequence or pattern at the start of the document [or] are they spread out, randomly, throughout the document with no pattern or order or sequence? 

- are the (b) links all in a sequence or pattern at the start of the document [or] are they spread out, randomly, throughout the document with no pattern or order or sequence? 

## For those two-way links that are on different pages ##

We need to sort between the start (a) and end (b) links. That is, which link comes first (a) and which comes second (b).

Once this is done, we need to assess:

- are the (a) links all in the same page?
	- if [YES], are they all in a similar pattern or sequence at the start or end of the page? Are they all, for example, within a common parent html tag, like a <div>, or ordered list, or something? 
	- if [YES], is that page near the start of the epub, according to "TOC.ncx"? If yes, does that page, in "TOC.ncx", feature the name "contents", anything suggesting these links are part of a table of contents?
	- [OR] are they all scattered throughout the page?

- are the (b) links all in the same page? 
	- if [YES], is that page near the end of the epub, according to "TOC.ncx"? If yes, does that page, in "TOC.ncx", feature the name "footnotes" [OR] "endnotes" [OR] "bibliography", or anything like that?
	- if [NO], does the page, in "TOC.ncx", feature the name "index" [OR] "glossary"?

# Once we have categorised all the one-way and two way links # 











i don't want to start coding yet, i want to gather all the info that i have on the data we can use from the files, so that we can have like a "logic tree", so that we are systematic about it. so, sometimes the files are already named in a way that we can use. 

let's start with figuring out the file name and structure that we want. we want the naming to be such that it will be arranged in a folder in ascending order properly. thats why we will use letters and numbers to get it this way.

I think it should be:

1. "1.html" this contains any information provided by publisher about the book. for example, content about the series the book is published in, or about the publisher, etc. it is the first kinda content of the book.

2. "A01_TitlePage.html" this page is commonly just the title, subtile and authors. 

To help identify it, there are the following information. It only contains several lines, and these lines correspond to the title, and authors. 

The title is likely in <h1> or <h2> tags. 

Some Div tags might have id or class = "title" or "title-page", or something like this.

3. "A02_copyright.html" this is the page of a book that has all the details necessary for citing the book, and the legal rights of the book. 

For example it will contain the name of the publisher, year, copyright symbol, place of publication, ISBN number, and so on. 

It may also contain a link to an online location for the record. 

4. "A03_dedication.html" this page is usually only containing a small quote. It might contain, instead, an acknowledgments section. 

As it rarely has a title saying "dedication" or "acknowledgments", this one will be harder to identify. It might even be that we should try to identify it at the end. We can deduce it, perhaps by working out:

- is it one of the early files in the folder? (this woud be a necessary variable)
- does it NOT contain the title of the book (this should be relevant but not sufficient variable)
- does it have any reference to pagenumbers in, for example <a id="p.1"> where an a tag is used simply to provide an anchor, not a link, and the id of that anchor is either a number or roman numeral, indicating an early page number. 
- a Div might have a class or id that means "acknowledgements" or "dedication", or something like that. 

5. "A04_TOC.html" this page is for the table of contents. 

	This can be identified as it will contain lots of <h1> and <h2> tags, most likely, and these will be links to various pages plus an ID, an ID of that table of contents page. 

	However, it may not have <h1> or <h2> tags. it might have: 

	<div class="toclevel1">
  		<a id="rchapter1" href="C08_chapter1_split_000.xhtml#chapter1" class="item2">1 Introduction</a>
	</div>

Still, the <a> tags might contain id="something" or class="something", which indicate links to chapters. For example in the above example, it has id="rchpater1", that is, it contains reference to a particular chapter.

If so, the rest of the page could be searched. Is the pattern repeated? 

Or something like that. 

6. "B01_Chapter1.html" this is the file for the first chapter. This might be an introduction chapter, preface or a forward, or somethings that is not actually chapter one according to the titles of the book. However, it is the first body of text of the book. 

7. "B01_Chapter2.html", the second chapter of the book. These are repeated, until the last text-based chapter of the book. 

8. "C01_Deepnotes1.html", and then "C01_Deepnotes2.html". These are optional files. Not all books will have it. It contains all the endnotes, or footnoes of a book which has these kept in seperate file/s. 

So, when parseing a file, if it contains lots of shorter bodies of text, with id= or class= something that sounds like footnotes, fn, or endnotes, en, and especially if these are numbered sequentially, and if they contain href="page.html#ref", that is, links that include a # for an id. 

Commonly, these pages will contain academic style citations. For example, an authors name, followed by title of a book, year published, etc etc.

Also, if a page contains <h1> or <h2> that features text like "references", or "bibliography", or "endnotes", or "sources", or something like this, then it is most likely a references or endnotes page. Then, it should be renamed to C01_Deepnotes1.html. Then, if there is another, it should be named C01_Deepnotes2.html, for example. 

9. "C02_Index.html" this is for the index page. This may contain <h1> or <h2> of an index. This will be similar to the footnotes pages, or deepnotes pages, except instead of having sentences, or paragraphs or academic references, it will be a list of singgle words or short phrases. 

10. There may be some other pages. Fore example, there might be a glossary, a page of tables, or maps, etc. If a page does not fit within any particular category defined above. Then they should be named, as an intermediate measure:

C03_Random1.html, and C03_Random2.html, and so on, and so forth. 


Once we have scanned to identify each file, we must keep a temporary record of which file name has been changed, and to what. This is essential. For, then, in a second step, we must change all the href="values", for each file. So, if file "3.html" has been changed to "A03_Copyright.html", then any link that was previously href="3.html", or href="3.html#refa", for example, should be converted to href="A03_Copyright" and href="A03_Copyright#refa", etc. This will ensure that the internal links between the files match their new titles. 

Does this make sense? Do you think the information and logic I have provided will be sufficient for correctly identifying the nature of each file of a folder of a book, so that it can handle most books, even if they contain different structures and naming conventions? What are the weakspots? Let me know your thoughts.
