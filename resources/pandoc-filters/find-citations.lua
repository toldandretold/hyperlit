-- resources/pandoc-filters/find-citations.lua (IMPROVED VERSION)

-- A global table to store the citations we find.
local citations_found = {}

function Para (p)
  local text = pandoc.utils.stringify(p)

  -- IMPROVED REGEX: This pattern is much more forgiving.
  -- It finds any text inside parentheses that contains a 4-digit year.
  -- It will match (Author 2023), (Author, 2023), and (Complex; citation, 2023)
  for content in text:gmatch '%(([^)]*%d%d%d%d[^)]*)%)' do
    table.insert(citations_found, {
      type = 'author-date',
      content = content
    })
  end

  return p
end

function Pandoc (doc)
  print("<!-- PANDOC_DATA_JSON:" .. pandoc.json.encode(citations_found) .. "-->")
  return doc
end