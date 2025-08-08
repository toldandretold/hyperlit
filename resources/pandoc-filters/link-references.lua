-- resources/pandoc-filters/link-references.lua (FINAL PRODUCTION VERSION)

function Pandoc(doc)
  -- All state variables are declared locally to ensure correct scope.
  local bibliography_map = {}
  local citations_found = {}
  local ref_counter = 0

  -- Helper function to create a consistent key.
  local function make_key(author, year)
    if not author or not year then return nil end
    local first_author = author:match("%w+")
    if not first_author then return nil end
    return first_author:lower() .. year
  end

  -- PASS 1: Build the bibliography map using the "Reverse Pass" strategy.
  -- We iterate through the document's blocks from the end to the beginning.
  for i = #doc.blocks, 1, -1 do
    local block = doc.blocks[i]
    -- We only care about paragraphs.
    if block.t == 'Para' then
      local text = pandoc.utils.stringify(block)
      -- Heuristic: Does it look like a reference entry?
      if text:match("^%u") and text:match("%d%d%d%d") then
        local author = text:match("^([%a%[%]’'%.%s,-]+)") -- Match author names more robustly
        local year = text:match("(%d%d%d%d)")
        local key = make_key(author, year)
        if key then
          bibliography_map[key] = text
          io.stderr:write("PASS 1: Found reference and created key: " .. key .. "\n")
        end
      else
        -- If it doesn't look like a reference, we've hit the main text.
        -- Stop building the bibliography immediately.
        io.stderr:write("PASS 1: Reached end of references. Stopping.\n")
        break
      end
    end
  end

  -- PASS 2: Find in-text citations and link them.
  local ref_linker = {
    Str = function(s)
      -- We operate on Str elements to replace text with tagged spans.
      local text = s.text
      local new_inlines = {}
      local last_index = 1
      for start_pos, citation_content, end_pos in text:gmatch("()%(([^)]*%d%d%d%d[^)]*)%)()") do
        -- Add the text that came before this citation.
        table.insert(new_inlines, pandoc.Str(text:sub(last_index, start_pos - 1)))

        local author = citation_content:match("^([%a%[%]’']+)")
        local year = citation_content:match("(%d%d%d%d)")
        local key = make_key(author, year)

        if key and bibliography_map[key] then
          ref_counter = ref_counter + 1
          local ref_id = "ref-" .. ref_counter
          table.insert(citations_found, {
            id = ref_id,
            type = 'linked-reference',
            content = bibliography_map[key]
          })
          io.stderr:write("PASS 2: Linked in-text '" .. citation_content .. "' to key: " .. key .. "\n")
          -- Wrap the citation in a span with our unique ID.
          table.insert(new_inlines, pandoc.Span('(' .. citation_content .. ')', {
            class = 'reference',
            ['data-ref-id'] = ref_id
          }))
        else
          -- If no link found, just put the text back as it was.
          table.insert(new_inlines, pandoc.Str('(' .. citation_content .. ')'))
        end
        last_index = end_pos
      end
      -- Add any remaining text after the last citation.
      table.insert(new_inlines, pandoc.Str(text:sub(last_index)))
      -- If we made any changes, return the list of new inlines. Otherwise, return the original.
      if #new_inlines > 1 then
        return new_inlines
      else
        return s
      end
    end
  }
  local final_doc = doc:walk(ref_linker)

  print("<!-- PANDOC_DATA_JSON:" .. pandoc.json.encode(citations_found) .. "-->")
  return final_doc
end