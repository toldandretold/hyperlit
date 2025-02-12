function parseMarkdownIntoChunks(markdown) {
    const lines = markdown.split("\n");
    const chunks = [];
    let currentChunk = [];
    let currentChunkId = 0;
    let currentStartLine = 1;
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        const adjustedLineNumber = i + 1;
        let block = null;
        if (trimmed.match(/^#{1,5}\s/)) {
            block = { 
              type: "heading", 
              level: trimmed.match(/^#{1,5}/)[0].length, 
              startLine: adjustedLineNumber, 
              content: trimmed.replace(/^#+\s*/, "") 
            };
        }
        else if (trimmed.startsWith(">")) {
            block = { type: "blockquote", startLine: adjustedLineNumber, content: trimmed.replace(/^>\s?/, "") };
        }
        else if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
            const match = trimmed.match(/^!\[(.*)\]\((.*)\)$/);
            block = { 
              type: "image", 
              startLine: adjustedLineNumber, 
              altText: match ? match[1] : "", 
              imageUrl: match ? match[2] : "" 
            };
        }
        else if (trimmed) {
            block = { type: "paragraph", startLine: adjustedLineNumber, content: trimmed };
        }
        if (block) {
            currentChunk.push(block);
        }
        if (currentChunk.length >= 50 || i === lines.length - 1) {
            chunks.push({ 
              chunk_id: currentChunkId, 
              start_line: currentStartLine, 
              end_line: adjustedLineNumber, 
              blocks: currentChunk 
            });
            currentChunk = [];
            currentChunkId++;
            currentStartLine = adjustedLineNumber + 1;
        }
    }
    return chunks;
}
window.parseMarkdownIntoChunks = parseMarkdownIntoChunks;




function renderBlockToHtml(block) {

    let html = "";
    if (!block || !block.type || typeof block.content === "undefined") {
        console.error("❌ Invalid block detected:", block);
        return "";
    }

    // Ensure each block is wrapped in a div with data-block-id
    let blockWrapper = `<div data-block-id="${block.startLine}">`;

    if (block.type === "heading") {
        let headingTag = `h${block.level}`;
        html += `<${headingTag} id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</${headingTag}>\n`;
    }
    else if (block.type === "blockquote") {
        html += `<blockquote data-block-id="${block.startLine}"><p id="${block.startLine}">${parseInlineMarkdown(block.content)}</p></blockquote>\n`;
    }
    else if (block.type === "image") {
        html += `<img id="${block.startLine}" data-block-id="${block.startLine}" src="${block.imageUrl}" alt="${block.altText}" />\n`;
    }
    else if (block.type === "paragraph") {
        // ✅ Ensure each paragraph gets an `id` based on its line number
        html += `<p id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</p>\n`;
    }

    return blockWrapper + html + `</div>\n`;  // Close block wrapper
}

window.renderBlockToHtml = renderBlockToHtml;

// Function to parse inline Markdown for italics, bold, and inline code
function parseInlineMarkdown(text) {
    text = text.replace(/\\([`*_{}\[\]()#+.!-])/g, "$1"); // Remove escape characters before processing
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // Convert **bold** to <strong>
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>"); // Convert *italic* to <em>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>"); // Convert `code` to <code>
    
    // Convert Markdown links [text](url) to HTML <a> tags
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return text;
}

window.parseInlineMarkdown = parseInlineMarkdown;

    function convertMarkdownToHtml(markdown) {
        const lines = markdown.split("\n");
        let htmlOutput = "";

        lines.forEach((line) => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("# ")) {
                htmlOutput += `<h1>${parseInlineMarkdown(trimmedLine.replace(/^# /, ""))}</h1>`;
            } else if (trimmedLine.startsWith("## ")) {
                htmlOutput += `<h2>${parseInlineMarkdown(trimmedLine.replace(/^## /, ""))}</h2>`;
            } else if (trimmedLine.startsWith("### ")) {
                htmlOutput += `<h3>${parseInlineMarkdown(trimmedLine.replace(/^### /, ""))}</h3>`;
            } else if (trimmedLine.startsWith(">")) {
                htmlOutput += `<blockquote>${parseInlineMarkdown(trimmedLine.replace(/^> /, ""))}</blockquote>`;
            } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
                const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
                if (imageMatch) {
                    const altText = imageMatch[1];
                    const imageUrl = imageMatch[2];
                    htmlOutput += `<img src="${imageUrl}" alt="${altText}"/>`;
                }
            } else if (trimmedLine) {
                htmlOutput += `<p>${parseInlineMarkdown(trimmedLine)}</p>`;
            }
        });

        return htmlOutput;
    }

window.convertMarkdownToHtml = convertMarkdownToHtml;

