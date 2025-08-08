-- resources/pandoc-filters/extract-text-refs.lua

local citations_found = {}
local citation_count = 0

-- This function runs on every paragraph
function Para(p)
  -- Use pandoc.utils.stringify to get the plain text of the paragraph
  local text = pandoc.utils.stringify(p)

  -- Find patterns like (Author, 2023) or (Author, 2023, p. 15)
  for match in string.gmatch(text, "%(([^)]+%,%s*%d{4}[^)]*)%)") do
    citation_count = citation_count + 1
    local ref_id = "autocite-" .. citation_count
    table.insert(citations_found, {
      id = ref_id,
      type = "author-date",
      content = match
    })
    -- This part is tricky: we can't easily replace the text here without
    -- messing up the document structure. For now, we will just extract.
    -- We can add replacement later if needed.
  end

  -- Find Markdown-style footnotes like [^1] or [^note]
  for match in string.gmatch(text, "%[%^([%w_]+)%]") do
    -- We need to find the corresponding definition
    local note_content = pandoc.utils.stringify(p.doc_meta['footnotes:' .. match])
    if note_content and note_content ~= "" then
        table.insert(citations_found, {
            id = "fn-" .. match,
            type = "footnote",
            content = note_content
        })
    end
  end

  return p
end

-- After processing, print the collected data as a JSON comment
function Pandoc(doc)
  -- This part is a bit more advanced. We need to walk the whole document
  -- to find footnote definitions first.
  local footnotes = {}
  local walker = {
    Note = function(n)
      -- Store footnote content in the document's metadata
      local key = 'footnotes:' .. #footnotes + 1
      doc.meta[key] = n.content
      footnotes[#footnotes + 1] = pandoc.Str('') -- Replace with empty string
      return footnotes[#footnotes + 1]
    end
  }
  -- Walk the document to process and remove footnote definitions
  local processed_body = pandoc.walk_blocks(doc.blocks, walker)

  -- Now walk the processed body to find references
  local final_doc = pandoc.walk_blocks(processed_body, { Para = Para })

  print("<!-- PANDOC_DATA_JSON:" .. pandoc.json.encode(citations_found) .. "-->")
  return pandoc.Pandoc(final_doc, doc.meta)
end