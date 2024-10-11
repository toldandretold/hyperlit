function Str(elem)
    -- Replace any occurrence of square brackets around quotes with just the quote.
    -- You can modify this pattern as needed for other characters.
    elem.text = elem.text:gsub("%[%’%]", "’")
    return elem
end