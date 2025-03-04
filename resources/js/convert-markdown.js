export function parseMarkdownIntoChunks(markdown) {
    const lines = markdown.split("\n");
    const chunks = [];
    let currentChunk = [];
    let chunkId = 0;
    let currentStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;
        const block = parseLineIntoBlock(line, lineNumber);

        if (block) {
            currentChunk.push(block);

            if (currentChunk.length >= 50) {
                chunks.push({
                    chunk_id: chunkId,
                    start_line: currentStartLine,
                    end_line: lineNumber,
                    blocks: currentChunk
                });
                chunkId++;
                currentChunk = [];
                currentStartLine = lineNumber + 1;
            }
        }
    }

    if (currentChunk.length > 0) {
        chunks.push({
            chunk_id: chunkId,
            start_line: currentStartLine,
            end_line: lines.length, // Use lines.length instead of lineNumber
            blocks: currentChunk
        });
    }

    return chunks;
}



function parseLineIntoBlock(line, lineNumber) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Check for headings
    const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
        return {
            type: 'heading',
            level: headingMatch[0].match(/^#+/)[0].length,
            content: headingMatch[1],
            startLine: lineNumber,
            lines: [line]
        };
    }

    // Check for blockquotes
    if (trimmed.startsWith('>')) {
        return {
            type: 'blockquote',
            content: trimmed.replace(/^>\s?/, ''),
            startLine: lineNumber,
            lines: [line]
        };
    }

    // Check for images
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\((.*)\)$/);
    if (imageMatch) {
        return {
            type: 'image',
            altText: imageMatch[1],
            imageUrl: imageMatch[2],
            startLine: lineNumber,
            lines: [line]
        };
    }

    // Default to paragraph
    return {
        type: 'paragraph',
        content: trimmed,
        startLine: lineNumber,
        lines: [line]
    };
}



export function renderBlockToHtml(block) {
    let html = "";
    if (!block || !block.type) {
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
        // Handle image blocks with proper fallbacks
        const imageUrl = block.imageUrl || '/path/to/default-image.jpg';  // Fallback image path
        const altText = block.altText || 'Image';  // Fallback alt text
        
        html += `<img 
            id="${block.startLine}" 
            data-block-id="${block.startLine}" 
            src="${imageUrl}" 
            alt="${altText}"
        >\n`;
    }
    else if (block.type === "paragraph") {
        html += `<p id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</p>\n`;
    }

    return blockWrapper + html + `</div>\n`;  // Close block wrapper
}





// Function to parse inline Markdown for italics, bold, and inline code
export function parseInlineMarkdown(text) {
    text = text.replace(/\\([`*_{}\[\]()#+.!-])/g, "$1"); // Remove escape characters before processing
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // Convert **bold** to <strong>
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>"); // Convert *italic* to <em>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>"); // Convert `code` to <code>
    
    // Convert Markdown links [text](url) to HTML <a> tags
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return text;
}



export function convertMarkdownToHtml(markdown) {
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


