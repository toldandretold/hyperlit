-- resources/pandoc-filters/link-references.lua (DEFINITIVE, WORKING VERSION)

function Pandoc(doc)
  local bibliography_map = {}

  -- Helper to create the unique, sorted key for citations.
  local function make_full_key(text)
    local year = text:match("(%d%d%d%d)")
    if not year then return nil end
    local authors_part = text:match("^(.-)" .. year)
    if not authors_part then return nil end
    local surnames = {}
    for surname in authors_part:gmatch("%u[%w’']+") do
      if not table.concat{ "And", "The", "For", "In" }:find(surname) then
        table.insert(surnames, surname:lower())
      end
    end
    if #surnames == 0 then return nil end
    table.sort(surnames)
    return table.concat(surnames, "") .. year
  end

  -- PASS 1: Build the bibliography map. This part works.
  for i = #doc.blocks, 1, -1 do
    local block = doc.blocks[i]
    if block.t == 'Para' then
      local text = pandoc.utils.stringify(block)
      if text:match("^%u") and text:match("%d%d%d%d") then
        local key = make_full_key(text)
        if key then bibliography_map[key] = text end
      else
        break
      end
    end
  end

  -- PASS 2: Find and tag citations at the Paragraph level.
  local ref_linker = {
    Para = function(p)
      local plain_text = pandoc.utils.stringify(p)
      
      -- Stage 1: Collect all matches without modifying anything.
      local matches = {}
      for start_pos, end_pos, citation_block in plain_text:gmatch("()(%(([%a%[][^)]*%d%d%d%d[^)]*)%))()") do
        table.insert(matches, {
          start = start_pos,
          stop = end_pos,
          text = citation_block
        })
      end

      -- If we didn't find any citations in this paragraph, do nothing.
      if #matches == 0 then
        return p
      end

      -- Stage 2: Rebuild the paragraph content from scratch.
      local new_inlines = {}
      local last_index = 1

      for _, match in ipairs(matches) do
        -- Add the text before this match.
        table.insert(new_inlines, pandoc.Str(plain_text:sub(last_index, match.start - 1)))

        -- Process the citation.
        local key = make_full_key(match.text)
        if key and bibliography_map[key] then
          -- If we have a match, create a Span.
          table.insert(new_inlines, pandoc.Span(match.text, {
            class = 'in-text-citation',
            ['data-key'] = key
          }))
        else
          -- If no match, just add it back as plain text.
          table.insert(new_inlines, pandoc.Str(match.text))
        end
        last_index = match.stop + 1
      end

      -- Add any remaining text after the last citation.
      table.insert(new_inlines, pandoc.Str(plain_text:sub(last_index)))

      -- Replace the paragraph's old content with our newly built content.
      p.content = new_inlines
      return p
    end
  }
  return doc:walk(ref_linker)
end