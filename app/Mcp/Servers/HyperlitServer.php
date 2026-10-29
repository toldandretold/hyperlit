<?php

namespace App\Mcp\Servers;

use Laravel\Mcp\Server;

/**
 * The Hyperlit MCP server — lets a user's own AI client act on their account
 * through typed tools. Served over Streamable HTTP at /mcp (routes/ai.php),
 * authenticated by a Sanctum personal access token whose ABILITIES
 * (read / annotate / import / spend — App\Mcp\TokenAbilities) gate each tool.
 *
 * V1 scope is the core research loop: search, read, highlight/annotate,
 * hypercite, import, export, shelves. Deliberately NOT here: book-content
 * editing (unified-sync node writes — waits on a model-proof restore story),
 * TTS/translation (v2), anything E2EE (server-opaque by design).
 */
class HyperlitServer extends Server
{
    protected string $name = 'Hyperlit';

    protected string $version = '1.0.0';

    protected string $instructions = <<<'MARKDOWN'
        Hyperlit is a social reading/annotation platform. You are acting AS the
        authenticated user — everything you create is attributed to them.

        Core concepts:
        - A BOOK is an ordered sequence of nodes (paragraphs/headings). Each node
          has a stable `node_id`, a positional `startLine` (decimal string, defines
          reading order), and a `chunk_id` (~100 nodes per chunk, for pagination).
        - A HYPERLIGHT is a highlight over a passage, optionally carrying an
          annotation (the user's note).
        - A HYPERCITE is a TWO-WAY citation link: an underlined passage in a
          SOURCE book and an arrow (↗) marker in a CITING book that point at each
          other. Creating the full two-way link means copying the passage and
          PASTING it into your own book — which needs book editing, NOT available
          yet. So `create_hypercite` only makes the SOURCE-side citable anchor and
          returns the copy-reference payload (the deep link + arrow HTML) for the
          user to paste manually; it does not create the citing side.
        - Books are identified by ids like `book_1712345678` or by their URL slug —
          tools accept either.

        Working effectively:
        - To read a book: `get_book` first (metadata + table of contents), then
          `read_book` with pagination — books can be thousands of nodes, never try
          to pull one in a single call.
        - To highlight: pass the passage as a VERBATIM quote from `read_book`
          output (plain text). The server anchors it by character offsets; if the
          quote appears more than once you'll get the match contexts back and can
          disambiguate with `occurrence`.
        - Imports run asynchronously: `import_document` returns a book id you poll
          with `import_status`. PREFER passing the full text you fetched/cleaned as
          `content` (Markdown) — the URL fetcher is unreliable, so only fall back to
          `url` when you can't get the text yourself. Binary files (docx/epub/pdf)
          go via `file_base64`. PDF imports cost the user money (OCR) and follow an
          estimate → confirm flow; the estimate response tells the user the price.
          import_document checks for an existing book of the same title first and
          returns the match instead of duplicating (pass force:true to override).
        - A good import workflow: search_library first (reuse if it exists) →
          import_document → import_status → set_book_metadata (give it a proper
          citation; lookup_citation_metadata resolves a reference string against
          OpenAlex for authoritative title/author/year/DOI/venue). To fix or
          re-run an EXISTING book without losing its URL or annotations, use
          reconvert_book, not a fresh import.
        - End-to-end-encrypted books cannot be read or written by the server (or
          by you) — tools refuse them with a clear message.
        - Your token may lack some abilities (read/annotate/import/spend); a
          denied tool names the missing ability. The user manages tokens in
          Account → AI access.
        MARKDOWN;

    /**
     * @var array<int, class-string>
     */
    protected array $tools = [
        \App\Mcp\Tools\ListBooksTool::class,
        \App\Mcp\Tools\SearchLibraryTool::class,
        \App\Mcp\Tools\SearchTextTool::class,
        \App\Mcp\Tools\GetBookTool::class,
        \App\Mcp\Tools\ReadBookTool::class,
        \App\Mcp\Tools\ListAnnotationsTool::class,
        \App\Mcp\Tools\ListShelvesTool::class,
        \App\Mcp\Tools\CreateHighlightTool::class,
        \App\Mcp\Tools\UpdateHighlightTool::class,
        \App\Mcp\Tools\DeleteHighlightTool::class,
        \App\Mcp\Tools\CreateHyperciteTool::class,
        \App\Mcp\Tools\ModifyShelfTool::class,
        \App\Mcp\Tools\ImportDocumentTool::class,
        \App\Mcp\Tools\ReconvertBookTool::class,
        \App\Mcp\Tools\ImportStatusTool::class,
        \App\Mcp\Tools\SetBookMetadataTool::class,
        \App\Mcp\Tools\LookupCitationMetadataTool::class,
        \App\Mcp\Tools\ExportMarkdownTool::class,
    ];
}
