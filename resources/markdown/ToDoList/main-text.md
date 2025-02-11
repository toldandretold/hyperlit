# To Do List [ : hyperlit]

## 1: Table of Contents (TOC)

TOC updates via a back-end process that launches when a heading tag is added or removed. This means passing through added and modified nodes when an editable div is saved. If a heading tag is detected, and it is from a removed node, that node should be deleted from a jason file. If it is in the added (modified) nodes, it should be added to the jason file, at the correct point.[^1] (It could be a database table that is used to update a jason file.)..

Should just be, whenever any of these happens, the python script is run again, as it needs to know the correct line number of heading tags.

The process involves parsing the main-text.md file, and noting the line number of each (# Heading) tag.

## 2: Search Bar

Essential to create a search bar at the top of the page. It searches not the DOM, but the main-text.md file that is being lazy loaded into the DOM. When a match is found, the line number of it is detected, and noted. This is used to create a function that lazy loads around that line of markdown. This works similarly to the internal links mechanism, so that user is taken directly to the search match, even if it is far away in a long, unloaded file. Once taken there, these words should be mildly highlighted, so user sees the result. 

At this pont, the search bar should have beneith it "next" and "back" buttons, so that user can move through the different search results. 

Search results are not refreshed as user types, but only when they manually press the search button again. 

## 3: Automated Hypercite database

On convert (cite-creator), Markdown and html citations are extracted, and put into a jason file. The footnotes are adjusted so that when pressed, the corresponding entry in the jason file appears as a floating div, or is a transparent div of the entire screen that covers the usual view, and then dissappears when canceled. 

The entries in the jason file should be further parsed by a back-end controller. This is done to get the data from the footnotes, and use it to create citation entries for any cited texts. As a result, the hypercite database will grow to include many references, even if these are marked as having "no hyperlit version")

Any of the jason data points that are successfully processed by this backend controller are updated, such that they are no longer just text footnotes, but the actual hyperlit record of a text. When such a footnote is pressed, it will conrain other buttons, including: [upload the source], which users can use to upload an alleged epub, .docx, or markdown version of the  hypercite. Thus, any user can help expand the number of texts that have a hyperlit edition. That is, a markdown version with full hyperciting and hyperlighting capabilities. 

## 4: Remember page location when leave page 

Detect when user leaves the page by:

- clicking external link

- closing page

When either is done, javascript should detect the html node IDs that are visible, ideally at the top of the page.

This should be saved to the page url in browser, or to a username or ip address, such that when user returns this html node id (and therefore markdown line number) is lazy loaded first, and navigated to.

## 5: Create reddit-notes homepage

Default homepage should be like apple notes. That is:

- lists notes with title and some initial text, according the date modified.
- most recently modified notes come first
- except for pinned notes

However, there should be tabs, such that users can choose to view only their notes, or all notes, or subscribed notes. 

And, beneath this, an option to change from "recent" to either: "most hyperlighted", "most hypercited", most seen", etc, with options for "day, week, month, year and all time." [this would be rolled out only so far as public hyperlighting and hyperciting are functional.]


## 6: Make work with iphone

Make the javascript and back-end controllers compatible with iphone browsers, particularly safari.

## 7: move online, with laravel-based sign-up and log-in

Self explanatory.

## 8: Add notifications

Once public hyperlighting and <mark class='user-name_1738192672757' id='user-name_1738192672757' data-listener-attached='true'>hyperciting</mark> are working, add notifations so users know when others have hyperlighted or hypercited their texts. This is an opt-in feature.

## 9: Fix lazy-loading issues... check caching 

Needs to be able to load updwards on scroll up on page load... rather than having to scroll down first then back up.

Also needs to check the caching... 

## 9: Click on highlight opens same div as used for footnotes, BUT

The div is filled with the hyperlights.md file, which is lazy loaded in, and targetted at the appropriate hyperlight using #highlight_id

User can scroll up and down in the div, and EDIT (if its users hyperlight), or, [LEAVE Hyperlight] if its someone-elses... 

Perhaps should auto-save this. 

[If click expand], the original div is entirely de-activated (all event listeners, and so on are silenced, scroll position and top ID are saved), and the hyperlights in right sidebar becomes full screen div... 

[if click a back-link]: the div collapses, with all event listeners and such turned off, and scroll position and top id saved].

In this way, moving between highlights and main-text should be super seamless.

## Notes [:]


[^1]: "When user types '[:]', an 'add citation' div appears from below, up to just below that [:] tag. User can type author/title/publisher <mark class='user-name_1738192705705' id='user-name_1738192705705' data-listener-attached='true'>details</mark> etc, as they do, any similar entries will appear as suggestions. They can also import a copy of the original text of the citation. [OR] they can click [New]. This automatically generates citation data of a new text, and opens a 'new hyperlit document', in editable div mode." [[:]](http://10.0.0.93:8000/todolist#hypercite_wck67b8)

