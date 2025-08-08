-- resources/pandoc-filters/tag-references.lua (FINAL PRODUCTION VERSION)

function Pandoc(doc)
  -- PASS 1: Find the bibliography at the end and wrap each entry.
  -- This part is working perfectly and remains unchanged.
  for i = #doc.blocks, 1, -1 do
    local block = doc.blocks[i]
    if block.t == 'Para' then
      local text = pandoc.utils.stringify(block)
      if text:match("^%u") and text:match("%d%d%d%d") then
        doc.blocks[i] = pandoc.Div(block, {class = 'bib-entry'})
      else
        break
      end
    end
  end

  -- PASS 2: Find in-text citations and wrap them in spans.
  -- This uses a new, more robust method.
  local ref_linker = {
    Str = function(s)
      local text = s.text
      local new_inlines = {}
      local last_index = 1
      -- Manually loop through all citation matches in the string.
      while true do
        -- Find the start and end position of the next citation.
        local start_pos, end_pos = text:find('%(([^)]*%d%d%d%d[^)]*)%)', last_index)

        if not start_pos then
          -- If no more citations are found, we're done with this string.
          break
        end

        -- 1. Add the text that came BEFORE the citation as a normal string.
        table.insert(new_inlines, pandoc.Str(text:sub(last_index, start_pos - 1)))

        -- 2. Add the citation itself, wrapped in a Span.
        local citation_text = text:sub(start_pos, end_pos)
        table.insert(new_inlines, pandoc.Span(citation_text, {class = 'in-text-citation'}))

        -- 3. Update our position to search after the citation we just found.
        last_index = end_pos + 1
      end

      -- Add any remaining text after the last citation.
      table.insert(new_inlines, pandoc.Str(text:sub(last_index)))

      -- Return the new list of elements (Strings and Spans).
      return new_inlines
    end
  }
  return doc:walk(ref_linker)
end