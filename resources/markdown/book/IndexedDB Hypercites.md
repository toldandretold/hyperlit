

# Steps 
## Stage One 

1. copied text (already done)
2. update DOM (done)
3. update nodeChunks for hypercites (similar to what we do with highlights)
4. update lazyLoading to be able to use this hyperciteData to insert U and A tags when necessary 

5. event listener for pasted hypercite... 
6. extract info to update nodeChunks for bookA
## Stage Two 

When clicking the hyperciteA U tag link, it opens the highlight Div, to show a plurality of places that the hypercited text has been pasted... this will enable the same hyperciteID to be cited in many different texts, and by different users. it is essentially a "cited by" div. 

## Stage Three

Instead of just "copying text", user presses a hyper cite button. 
This copies the text and also opens a div that shows a user's recently edited books. 
This will make it easier for user to go to the book that they were wanting to paste the citation. 




# Background

## When copied:
- copied text creates an update to the hypercites array in indexedDB
- this stores: hyperciteIDa, charStart and charEnd, hypercited text, url: "[initially empty]"
- ```
<u id="hyperciteIDa"> hypercited text </u>``` is added to DOM, the u tags are not addeed to the "content" of node chunks, but their startChar and endChar are calculated and added to nodeChunks in the hypercite array. 
- the copied text in clipboard is formatted as it was before: 
```
"hypercited text" <a href="url.com/book/hyperciteIDa" class="hypercite">[:]</a>
```

## When pasted
- event listener listens for any 
```<a class="hypercite"></a>```
- when it detects one being pasted, it checks if it has an id. If it doesn't, it generates a new hyperciteID, which will be hyperciteIDb.
- This is added to the anchor tag:

``` "hypercited text" <a href="url.com/book/hyperciteIDa" class="hypercite" id="hyperciteIDb>[:]</a>```

- the href of the pasted anchor tag is then used to extract the hyperciteIDa, and booka (the origin of the hypercite). for example, in this case it is:
	hypercitea { book: book,
				hyperciteIDa: hyperciteIDa}
- This is used to update the indexedDB of the nodeChunks for that book. The hypercites for that book are searched for using the hyperciteIDa. Once found, hyperciteIDb and url are updated, so that booka's hypercite details contain the info for where the hypercite was pasted. 

## When Loaded 
With this information, the hypercited text can be adjusted when the page is lazy loaded (or instantaneously), such that the nodeChunk with the startChar and endChar for a hypercite receive:

```<a href="bookb/hyperciteIDb"><u id="hyperciteIDa">hypercited text</u></a>```

Thus, whenever user clicks on this, they will be taken to bookb/hyperciteIDb, where the hypercited text was pasted. there, they will find the [:] which will link back to booka/hypeciteIDa... 

this will all be done with indexedDB... 





