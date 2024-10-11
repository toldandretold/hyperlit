-- Function to remove Div blocks and any unnecessary custom attributes
function Div(el)
    -- Remove all div blocks
    return pandoc.Null
end

-- Function to remove Span blocks (common in metadata)
function Span(el)
    return pandoc.Null
end

-- Remove any unwanted attributes from elements
function removeAttributes(el)
    if el.attr then
        el.attr = pandoc.Attr() -- Removes attributes but keeps content
    end
    return el
end

-- Customize Headers to simple Markdown-style
function Header(el)
    local level = el.level
    local hashes = string.rep("#", level)
    return pandoc.Para({pandoc.Str(hashes .. " "), pandoc.Str(pandoc.utils.stringify(el))})
end

-- Keep Links in Markdown format, but remove extra attributes
function Link(el)
    return removeAttributes(el)
end

-- Preserve Superscripts in HTML
function Superscript(el)
    return pandoc.RawInline('html', '<sup>' .. pandoc.utils.stringify(el) .. '</sup>')
end

-- Process paragraphs and remove attributes
function Para(el)
    return removeAttributes(el)
end

-- Remove unnecessary block elements like "RawBlock"
function RawBlock(el)
    -- Remove raw content like article tags, section tags, and other metadata
    return pandoc.Null
end

-- Remove inline raw content like images, icons, and extra metadata
function RawInline(el)
    -- Strip out inline raw content like images and metadata
    return pandoc.Null
end

-- Remove unnecessary image elements
function Image(el)
    return pandoc.Null
end
