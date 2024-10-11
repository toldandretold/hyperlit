test
====

Future GPT Chats
----------------

Immediate steps to get it working for me as a solo users

> Get {book} to update the main-text.html to main-text.md file after a highlight is created or deleted.
> 
> Get hyperlights.html to update hyperlights.md when user presses save, and vice versa. So steps would be
> 
> 1. update highlights database with annotations.
> 2. if it's markdown, convert to html and update hyperlights.html
> 3. if it's html, convert to md and update hyperlights.md

Adding in a test line.

Currently, this is being done by taking from the annotations column. The problem is that this is a raw string without any md or html. So, when markdown is changed, it doesn't update the html side with appropriate markup.

For now, can revert to converting file to the other. However, it is probably also good to work out how to store the selected text as html or md in the annotations column, and then to convert these after they are inserted into the hyperlights file. This

ToldandRetold hyperBase
=======================

When page loads the markdown or html, it is entered into a database table for that particular book's book\_id.

> 1. page is opened via url/{book}, where {book} is both the folder name, and the books unique @id \[@book\_id\], as stored in the bibteX data, and in the citations data folder.
> 2. the PageController.php looks in the folder.
> 
> If there is only main-text.html, this is loaded into the blade template of read-book.blade.php.
> 
> If there is only main-text.md, this is converted, via the MappedCommonmark.php controller, into main-text.html and stored in the @book\_id folder.
> 
> If there are both main-text.md and main-text.html in the @book\_id folder, then the PageController.php finds which has the most recent update time stamp.
> 
> If the most recently updated is the html, then the html is loaded into the read-book.blade.php view file (Hyperlit/resources/views/), and it is also converted, via MappedCommonmark.php, into the latest update of main-text.md the old main-text.md still exists, its in a different column of the databse, under a different time\_stamp, for version control. But, actually, its characters are still updated, automatically, in so far as they are still on the page. So, if readers prefer an older, more original form of the document (as opposed to one that the author has edited), then they can continue to load that version, and comment on it.
> 
> 3. With the most up-to-date html loaded into the browser, each letter is also inserted, row by row in a new column, with the latest time stamp. This is compared to the last time that the text had been saved in this position in the @book\_id table.
> 
> If the two columns align perfectly, then the old data column is deleted. For it is a complete replica.
> 
> If there are differences,then these need to be compared.
> 
> Working from the start of each column, values are compared, so that all the discontinuities are discovered.
> 
> Once each discontinuity start point is discovered, the parser notes the value of the character in that position in the oldest version.
> 
> Then, it parses through the newest column until it finds the same value. Then, it compares the next row of data from the older column, with the next row of data from the newer column. If they match, repeat. If a discontinuity arises, the character in the older column is noted. The newer column is passed until that same value appears. Then, when it does, its position is noted.
> 
> With this data, we can work out when the newest file had characters either added, or delted. If characters were added, then they are inserted, at the discontinuity point, and time\_stamped. This automatically shifts the values of the global\_position for each character that follows the added characters. If the rows of data have been deleted, by the author, they are not removed, but the deleted characters do receive deleted\_time\_stamp in the authors column, and a forced null for global position, which means the next, non-deleted characters are revalued accordingly. Its just like deleteing rows of data from excel, but instead of htem being deleted, they are effectively being cut out and pasted to the bottom of the page, because table is sorted by global\_position with 'null' values put to the bottom, uncounted.

This effectively solves the problem of how to update the highlights. The data table for each @book\_id has columns for each user. These start at null. However, if a user highlights text, then the global\_position of the first character is marked

However, if other users have also marked a character with 'HL', then its opacity will be darkened.

In fact, the CSS should have some kind of forumula, whereby a given HL score for each character gives it a given css highlight intensity, and these should fade, in a given pattern, form character to character.

Thus, the page will be covered in a hyperlight heat map. It will have three different colours bleading into each other. Unless there is only one, or two highlights. If there are three, then there is an inner, darkest intensity, then a mid intensity, and a weakest intensity.

There will be java-script so that each different region triggers a different page, filled with the hyperlights of that region of text with annotations.

Thus, people's hyperlights, and their annotations, become public, in-text comments, that are viewed alongside the annotations that others have left for the same region of text.

However, this is done in an orderly, and visually pleasing way.

For example, if user clicks on a red colour of the hyperlight heat map that spans characters 10-15, then they will be taken to a blade view that brings up any users hyperlight that

these differeny hyperlights can be re-organised in that hyperlights.blade.php template as an editable div, where that is within a div="highlight\_id", is added to the annotations column of that highlight\_id, stored as markdown.

when this page is saved, any text in divs with id="highlight\_id" have their contents updated to the annotations table for those highlight\_ids.

this means that, if user goes to url/hyperlights.md, they can see all their hyperlights pasted in markdown format. If these are edited, it is saved back to the annotations column for the highlight\_

according to fixed, mathematical schema, which will produce deep, rich and evolving heat maps.

```
     are the points of re-converennce. How far this is from the previous discontinuity is an expression of how many characters have either been deleted from one, or added to the other, in any possible combination of these two possibilities. 
>
>with the reconvergence noted, the parser continues down each column, until a new discontinuity is found. The process repeats down through till the end of both columns.
>
>At the end of the process, we have gathered some data. This includes: the total length of each column, and the difference. 
>Is one +6 or -6 from the other?
>
>This total difference figure must be compared to the summation of all the different discontinutity to reconvergence gaps. 
>
>If the figures are identical, then we know that the column that is +6 has either had 6 added, or the colum that is -6 has had 6 removed. 
If the older file is positive, then we know they were removed
If the older file is negative, then we know they were added.
Therefore, we can conclude that all data gaps were positive for the positive column.
>
    >However, if the total difference and the sum of all data gaps is not the same, then it means that the most recent version has had both text deleted and text added, at various points. 
    > We know, however, that the other file, the older one, has not been changed. 
    >Thus, we can know




```

1. Each character of the html

and after having loaded in the browser, are filtered down into two columns. // There two columns are compared, manually and by you, chatGPT. The goal is to look for any patterns in the differences of character position between the two renderings. //

2. This character position and count is compared to the one from the last time the page was saved.
3. Working from the start, down each column, the parser will notice a change. This is either because text, from this point, has been inserted or deleted in either of the two columns.
    
    Most important, though, is the column for the positions of all characters the last time this was c
    
    If some have been deleted from column\*(b) from the row 5-10, then column\*(a) will have 5 rows with different characters until it logs, in row a11, the same value as row b6. If from this pont on, from b6 and a11, the two columns match up, then we can determine that values had either been added or deleted.
    
    Even if one row ends exaclty 5 spaces below the other, this doesn't mean that the columns were either
    
    from column\_(a)
    
    from row 5 - 10, then
    
    it will take column b
    
    it will take several steps down the data column, until column b registers the row of data that was the first one for a after the columns went out of sync. These rows are labelled as deleted in the user who had deleted them Their column for that book marks those original letters as deleted to the central database for that book.
    
    What's the significance of this?
4. When a person highlights text, the computer detects the character position of each selected character, and checks a highlighted yes/no boolean data column, changing from no to yes for those characters.
5. then, a javascript function/method is called, which a. inserts and tags both before the first character count form the selected text, and immediately after the last one.
6. 

Updating html&lt;&gt;markdown conversion
----------------------------------------

> 1. switch to commonmark converter.
> 2. get rangy working for nesting multiple highlights
> 3. assess how this happens in practice with html tags, so as it insert a counter that adds a value to a HL\_order column, for the row that corresponds to the highlights highlight\_id.
> 4. switch out the highlight html for \[HL:n\]*highlighted text*\[/HL:n\].
> 5. then, when converting the edited markdown back to html, the \[HL:n\] tags are switched out, using their corresponding highlight\_ids, to the highlight tags understood by rangy.

The result should be markdown which would feature highlights like this:

```
This is <span class="highlight_id" data-highlight-id="1">some </span><span class="highlight_id" data-highlight-id="1 2">sample text</span><span class="highlight_id" data-highlight-id="2"> that</span> will be highlighted.




```

Which will correspond to a markdown of:

```
This is [HL:1]some [/HL][HL: "1,2"]sample text[/HL][HL: 2] that[/HL] will be highlighted.




```

I'll have to see if this is something that Chat reckons is feasible. But the point is that these numbers, 1 and 2, would correspond in the highlights table to specific highlight\_ids, and so when it goes to converting the markdown to html, it would be able to regenerate the same <span> tags as previously.</span>

a check would have to be carried out, such that, if \[HL\] or \[/HL\] tags were deleted in the markdown, this wouldn't interfere with the logic of converting the rest of them back into html.

Hypercite functionality\[:\]
============================

When a hypercite is pasted into a hyperlit article, an event listener detects that the \[:\] symbol (which could be switched out with javascript for a custom hyperlit "negative space" symbol) has been pasted. this triggers some javascript which:

> 1. posts the URL of the current hyperlit article to the backend controller "hyperCite", which adds it to the column "pasted" in the hypercite data \[table\].
> 2. the controller then opens the file from the "copied" row for the hypercite with the id from the id of the hypercite.
> 3. it adds the URL from the "pasted" column of the hypercite to the href="", of the [ tags with the hypercite's id.]()[1. the controller then triggers a click response for the save button (not sure how this would be done in code?). ]()[]()

The intended result is that the quoted text is followed by a \[:\] symbol, which links diretly back to that text in the hyper-source, which is now underlined, <ins>with another negative space hyperlit symbold at the end</ins>\[:\] Hopefully, this actually looks good, because then we won't need to change much by way of design. This is something that we may need to consult Simon on.

Idea for when the hyperlights nad hypercites get too overwhelming
=================================================================

Users should be able to customise which hyperlights and hypercites appear in their text. They can select from "most recent", "most upvoted", and "most read", for example. This will be calculated, eventually, also by the highlights and citations data table. Which will correspond with javascript, I think, for removing and displaying the relevant hyperlights and hypercites.

However, if user presses a highlight, for example, all highlights that overlap with that will also be opened, in a single html page, for example.

Also, if multiple sources have cited the same hypercite, then when it is pressed, these will appear, also in the same html page, showing them as different citations. That is, author, title and date. If these are pressed, user is taken into the exact location of the quote. If the \[:\] is pressed, user is taken back to all the hypercites. Back again, and to the original location in the main-text.

In this way, users will move freely between each hyperlit source, whether from the quoted text to the primary source, or from the primary source to all those which have hypercited it.

Repeating for reading and editing hyperlights
---------------------------------------------

Once this is set up, a similar thing will need to be established for the hyperlights.md

syncing to a local folder?
==========================

Ideally, all markdown files can be synced, via alliases, to a folder that syncs to a users account. This can, in theory, be synced to -- for example -- Obsidian.

Thus, users could have a completely socially interractive hypercite and hyperlight experience, and be able to connect with it via both browser, phone app, and obsidian.