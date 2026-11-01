<?php

namespace App\Mcp\Servers;

use Laravel\Mcp\Server;

/**
 * The Hyperlit MCP server — lets a user's own AI client act on their account
 * through typed tools. Served over Streamable HTTP at /mcp (routes/ai.php),
 * authenticated by a Sanctum personal access token whose ABILITIES
 * (read / annotate / import / write / spend / report — App\Mcp\TokenAbilities)
 * gate each tool. Auth is OPTIONAL at the HTTP layer (McpOptionalAuth): a
 * token-less GUEST completes the handshake but sees only get_connected,
 * the onboarding walkthrough — see docs/mcp.md.
 *
 * Scope: the core research loop (search, read, highlight/annotate, hypercite,
 * import, export, shelves) PLUS book writing on owned books (update_node /
 * append_nodes / cite_passage — all ride unified-sync, so nodes_history
 * versions every edit: that is the restore story that used to gate this).
 * Deliberately NOT here: TTS/translation (v2), anything E2EE (server-opaque
 * by design).
 */
class HyperlitServer extends Server
{
    protected string $name = 'Hyperlit';

    protected string $version = '1.0.0';

    /**
     * One page must hold the WHOLE toolset. The vendor default (15) splits
     * the registry mid-list, and real clients do not reliably follow
     * nextCursor: OpenCode showed an agent only the first 15 tools, so it
     * concluded import_document "isn't available", decided append_nodes on
     * an EXISTING book was the only way to get a container, and rewrote one
     * of the user's books. A truncated tool surface is not a smaller
     * feature set — it is an agent improvising around a hole. Keep this >=
     * count($tools); the gate in McpServerTest counts the registry against
     * an UNPAGINATED default tools/list.
     */
    public int $defaultPaginationLength = 50;

    /**
     * Shown to a token-less (GUEST) connection: McpOptionalAuth lets those
     * through so a connecting agent can learn how to get its user a token
     * instead of hitting a dead 401. boot() picks the variant per request.
     */
    private const GUEST_INSTRUCTIONS = <<<'MARKDOWN'
        Hyperlit is a social reading/annotation platform — an open docuverse of
        books, articles and annotations.

        You are connected as a GUEST: no Authorization header was sent, so no
        data tools are available. To act on a user's account (read their
        library, annotate, import, write), the user must mint a personal
        access token in the Hyperlit web app and your client must send it as
        the header "Authorization: Bearer <token>".

        Call the get_connected tool for the exact steps and client
        configuration, and relay them to the user — minting a token requires
        a human in the browser.
        MARKDOWN;

    private const AUTHED_INSTRUCTIONS = <<<'MARKDOWN'
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
          other. `cite_passage` completes the FULL two-way link in one call —
          it anchors the source passage AND splices the arrow into a node of a
          book YOU OWN (the source book can be anyone's readable book).
          `create_hypercite` still exists for the human flow: it makes only the
          SOURCE-side anchor and returns a copy-reference payload the user can
          paste in the web editor.
        - Books are identified by ids like `book_1712345678` or by their URL slug —
          tools accept either.

        Working effectively:
        - FINDING SOURCES: `search_text` is the research entry point and is
          SEMANTIC by default — describe the topic or claim you want passages
          about ("the political economy of land enclosure"), not keywords; it is
          the same meaning-based retrieval the AI Archivist runs on. Use
          mode=fulltext only to locate an exact phrase, and `search_library`
          only when you can NAME the work (it matches bibliographic metadata,
          never content).
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
        - Scholarly databases: search_sources finds works across OpenAlex / Open
          Library / Semantic Scholar; find_full_text locates a free open-access
          copy of a DOI; lookup_citation_metadata resolves a raw reference
          string. These are free. A natural flow: search_sources or
          find_full_text → fetch the open-access text → import_document.
        - AI Citation Review checks whether each citation's source actually
          supports its claim. run_citation_review starts it (a long async job);
          poll get_citation_review for progress and the finished report. Set
          use_my_model=true to do the LLM analysis on YOUR model for free (the
          user only pays for source-fetching infrastructure). In that mode you
          MUST drain the work: loop claim_review_work → answer each returned
          prompt in your own turn (follow its format exactly) → submit_review_
          verdict, repeating until get_citation_review reports "completed".
          Answer promptly (claimed items expire in ~15 min); if you stop, the
          review pauses and can be resumed by running it again.
        - WRITING BOOKS (write ability, owned books only): `update_node` replaces
          one node's content; `append_nodes` adds blocks at the end (positions
          are minted server-side — never invent startLines); `cite_passage`
          completes a two-way citation. Every edit is versioned server-side and
          restorable. A NEW book is ALWAYS created with `import_document`
          (content as plain Markdown) — there is no create_book tool. NEVER
          repurpose or overwrite an existing book as a container for new
          writing; if import_document is not in your tool list, your client
          truncated it (ask for tools again or tell the user) — the tool
          exists, and the fallback is to STOP, not to rewrite a book. The AGENT-NATIVE ARCHIVIST recipe — research a question and
          publish an answer whose sentences cite their sources: search_text
          (semantic — the retrieval the web archivist runs) → read_book the hits
          in context → import_document the
          answer as PLAIN prose (no citation markup — the importer refuses
          hypercite HTML because it cannot wire it) → cite_passage once per
          citation (citing_node_id + after_text placing each arrow, quote naming
          the source passage) → update_node to revise. ARROW PLACEMENT: the ↗
          belongs to the exact claim it supports — set after_text to end at
          that clause, one arrow per claim, never piled at paragraph end; a
          clause citing several sources repeats the call with the same
          after_text and the server merges the arrows into ONE grouped ↗ with
          a chooser. PREFER insert_quote=true
          when your sentence quotes the source: the server inserts the VERBATIM
          anchored passage in quotes before the arrow ('…'↗ — the archivist and
          web-paste convention), so the quote is guaranteed byte-identical to
          the source; arrow-only (default) is for citing after your own prose.
          The cited books' owners are notified and connection counts update,
          exactly as if the user had pasted the citation in the editor.
        - End-to-end-encrypted books cannot be read or written by the server (or
          by you) — tools refuse them with a clear message.
        - Something broken? If a tool itself malfunctions (crash, wrong result,
          nonsensical refusal) and your token has the 'report' ability, file it
          with report_bug after telling the user.
        - Your token may lack some abilities (read/annotate/import/write/spend/
          report); a denied tool names the missing ability. The user manages
          tokens via the user button → Data sovereignty → MCP for AI access.
        MARKDOWN;

    /**
     * The vendor Server reads $this->instructions when it builds the per-
     * request context, and boot() runs before every handle() — so the guest
     * variant is swapped in here. "Guest" means an actually-ROUTED request
     * with no sanctum user: console contexts (mcp:inspector, artisan) carry
     * an unrouted placeholder request and must keep the full instructions —
     * checking runningInConsole() instead would also misfire in the HTTP
     * feature tests, which run inside the console.
     */
    protected string $instructions = self::AUTHED_INSTRUCTIONS;

    protected function boot(): void
    {
        $request = app()->bound('request') ? request() : null;

        if ($request?->route() !== null && $request->user('sanctum') === null) {
            $this->instructions = self::GUEST_INSTRUCTIONS;
        }
    }

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
        \App\Mcp\Tools\CitePassageTool::class,
        \App\Mcp\Tools\UpdateNodeTool::class,
        \App\Mcp\Tools\AppendNodesTool::class,
        \App\Mcp\Tools\ModifyShelfTool::class,
        \App\Mcp\Tools\ImportDocumentTool::class,
        \App\Mcp\Tools\ReconvertBookTool::class,
        \App\Mcp\Tools\ImportStatusTool::class,
        \App\Mcp\Tools\SetBookMetadataTool::class,
        \App\Mcp\Tools\LookupCitationMetadataTool::class,
        \App\Mcp\Tools\SearchSourcesTool::class,
        \App\Mcp\Tools\FindFullTextTool::class,
        \App\Mcp\Tools\RunCitationReviewTool::class,
        \App\Mcp\Tools\GetCitationReviewTool::class,
        \App\Mcp\Tools\ClaimReviewWorkTool::class,
        \App\Mcp\Tools\SubmitReviewVerdictTool::class,
        \App\Mcp\Tools\ExportMarkdownTool::class,
        // Registered for EVERYONE including guests (extends the vendor Tool,
        // not HyperlitTool) — the onboarding surface. Keep it last-ish so the
        // data tools lead the authed listing.
        \App\Mcp\Tools\GetConnectedTool::class,
        // Registers only when the token carries the 'report' ability — the
        // consent checkbox at token creation.
        \App\Mcp\Tools\ReportBugTool::class,
    ];
}
