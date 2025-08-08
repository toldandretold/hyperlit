-- filter.lua
local citations_found = {}
local footnote_count = 0

-- This function is called for every 'Cite' element in the document
function Cite(el)
  -- For each citation like (Smith, 2020)
  for _, citation in ipairs(el.citations) do
    -- Generate a unique ID for this citation
    local citation_id = "cite-" .. citation.id
    table.insert(citations_found, {
      id = citation_id,
      type = "author-date",
      content = citation.id -- e.g., "prashad2007" from a bib file
    })
    -- Replace the citation in the text with a placeholder span
    el.content = {
      pandoc.Span(
        el.content,
        { class = "reference", ["data-ref-id"] = citation_id }
      )
    }
  end
  return el
end

-- This function is called for every 'Note' element (footnote)
function Note(el)
  footnote_count = footnote_count + 1
  local note_id = "fn-" .. footnote_count
  table.insert(citations_found, {
    id = note_id,
    type = "footnote",
    -- Convert the footnote content (which is a list of blocks) to plain text
    content = pandoc.utils.stringify(el.content)
  })
  -- Replace the footnote in the text with a clickable sup tag
  return pandoc.Span(
    { pandoc.Str(tostring(footnote_count)) },
    { class = "note", ["data-ref-id"] = note_id }
  )
end

-- After processing, print the collected data as a JSON comment
function Pandoc(el)
  print("<!-- PANDOC_DATA_JSON:" .. pandoc.json.encode(citations_found) .. "-->")
  return el
end