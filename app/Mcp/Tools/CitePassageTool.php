<?php

namespace App\Mcp\Tools;

use App\Mcp\Support\BookContentWriter;
use App\Mcp\TokenAbilities;
use App\Services\Annotations\AnchorAmbiguousException;
use App\Services\Annotations\AnchorNotFoundException;
use App\Services\Annotations\AnnotationAnchorService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Completes a TWO-WAY hypercite in one call: anchors the quoted passage in the
 * SOURCE book (an underlined citable span, as create_hypercite does) AND
 * splices the ↗ arrow into a node of the CITING book, wiring citedIN so both
 * sides point at each other. This is the step that used to require pasting in
 * the web editor.
 *
 * Ownership: the caller must OWN the citing book (content is spliced into it);
 * the source book only needs to be readable — citing anyone's public book is
 * the point. The source-side anchor row is always the caller's own (never
 * mutates a hypercite someone else created).
 *
 * The write rides unified-sync (one transaction: citing node + cited row), so
 * notification fan-out, connection-count refresh, annotation recalc and the
 * E2EE/sanitizer guards all behave exactly as a web paste.
 */
#[IsIdempotent(false)]
class CitePassageTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'cite_passage';

    protected string $description = 'Complete a TWO-WAY hypercite: anchor a verbatim quote in a source book AND splice the ↗ citation arrow into a node of a book YOU OWN, wiring both sides (citedIN) in one transaction. Use after writing your book (import_document / append_nodes): pass the citing node and optionally after_text (a verbatim snippet inside that node the arrow should follow; omit = end of node). The source book just needs to be readable. Quote the source passage VERBATIM from read_book plain output. PLACEMENT: the ↗ belongs to the exact claim it supports — set after_text to end at that clause (right after its closing punctuation), one arrow per claim; do NOT pile arrows at the end of a paragraph. When one clause genuinely cites several sources, repeat the call with the SAME after_text: adjacent arrows are automatically merged into ONE grouped ↗ with a reader-side chooser (never two arrows in a row). Parallel calls are safe — even on the same node, concurrent splices are serialized, never lost.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'citing_book' => $schema->string()->required()
                ->description('The book YOU OWN that is doing the citing (id or slug). The arrow is spliced into one of its nodes.'),
            'citing_node_id' => $schema->string()->required()
                ->description('The data-node-id of the citing node (from read_book output).'),
            'after_text' => $schema->string()
                ->description('Verbatim snippet inside the citing node; the arrow is inserted right after it. Omit to place the arrow at the end of the node.'),
            'source_book' => $schema->string()->required()
                ->description('The CITED book (id or slug) — any readable book.'),
            'quote' => $schema->string()->min(3)
                ->description('The exact source passage to cite, verbatim from read_book plain output. Required unless source_hypercite_id is given.'),
            'occurrence' => $schema->integer()
                ->description('1-based: which occurrence of the quote to anchor when it appears multiple times.'),
            'source_hypercite_id' => $schema->string()
                ->description('Reuse an anchor YOU already created (e.g. via create_hypercite) instead of passing quote.'),
            'insert_quote' => $schema->boolean()
                ->description('true = insert the VERBATIM source passage in quotes before the arrow (\'…\'↗ — the archivist/web-paste convention; the server inserts the exact anchored text, so the quote is guaranteed identical to the source). false (default) = insert only the ↗ arrow after your own prose.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'citing_book' => 'required|string',
            'citing_node_id' => 'required|string',
            'after_text' => 'nullable|string',
            'source_book' => 'required|string',
            'quote' => 'nullable|string|min:3',
            'occurrence' => 'nullable|integer|min:1',
            'source_hypercite_id' => 'nullable|string',
        ]);

        if (! $request->get('quote') && ! $request->get('source_hypercite_id')) {
            return Response::error('Pass either quote (to anchor a new passage) or source_hypercite_id (to reuse your own anchor).');
        }

        $user = $this->user($request);

        [$citingBook, $refusal] = $this->resolveBook((string) $request->get('citing_book'));
        if ($refusal) {
            return $refusal;
        }
        [$sourceBook, $refusal] = $this->resolveBook((string) $request->get('source_book'));
        if ($refusal) {
            return $refusal;
        }

        if (! BookContentWriter::ownsBook($user, $citingBook)) {
            return Response::error('You can only cite INTO a book you own. The citing book\'s creator must be you; the source book is the one that can belong to anyone.');
        }

        // ── Source side: an anchor row the CALLER owns ──────────────────────
        $sourceHyperciteId = (string) ($request->get('source_hypercite_id') ?? '');
        $hyperciteItems = [];

        if ($sourceHyperciteId !== '') {
            $existing = DB::table('hypercites')
                ->where('book', $sourceBook)
                ->where('hyperciteId', $sourceHyperciteId)
                ->first();
            if (! $existing) {
                return Response::error('That source_hypercite_id was not found on the source book.');
            }
            if (($existing->creator ?? null) !== $user->name) {
                return Response::error('That hypercite was created by someone else — anchor your own with quote instead (hypercite updates only apply to rows you created).');
            }
            $citedIn = json_decode($existing->citedIN ?? '[]', true) ?: [];
            $hypercitedText = (string) ($existing->hypercitedText ?? '');
            $sourceNodeIds = json_decode($existing->node_id ?? '[]', true) ?: $existing->node_id;
            $sourceCharData = json_decode($existing->charData ?? '[]', true) ?: [];
        } else {
            $nodes = $this->fetchNodes($sourceBook, $user);
            if ($nodes instanceof Response) {
                return $nodes;
            }
            try {
                $anchor = AnnotationAnchorService::locate(
                    $nodes,
                    (string) $request->get('quote'),
                    $request->get('occurrence') !== null ? (int) $request->get('occurrence') : null,
                );
            } catch (AnchorAmbiguousException $e) {
                return Response::error(
                    $e->getMessage()." Retry with occurrence set to the 1-based index you mean:\n"
                    .collect($e->contexts)->map(fn ($c, $i) => ($i + 1).'. '.$c)->implode("\n")
                );
            } catch (AnchorNotFoundException $e) {
                return Response::error($e->getMessage());
            }
            // Same mint shape as create_hypercite / the web client.
            $sourceHyperciteId = 'hypercite_'.Str::lower(Str::random(7));
            $citedIn = [];
            $hypercitedText = $anchor['highlightedText'];
            $sourceNodeIds = $anchor['node_ids'];
            $sourceCharData = $anchor['charData'];
        }

        // ── Citing side: splice + write, under honest optimistic concurrency ──
        // The library content clock is captured BEFORE the node is read and
        // passed to sync as base_timestamp, so anything that lands between
        // this read and the transaction gets the 409 — and the loop re-reads,
        // re-splices and retries. Without that pairing, parallel cite_passage
        // calls on one node each read the same content, spliced, and the last
        // writer won: three arrows vanished while every call reported success
        // (OpenCode, 2026-11-01).
        $baseCitedIn = $citedIn;
        $insertQuote = $request->boolean('insert_quote');
        $afterTextInput = (string) ($request->get('after_text') ?? '');
        $write = null;
        $anchorId = '';
        $merged = false;

        for ($attempt = 0; $attempt < 3; $attempt++) {
            $baseTimestamp = BookContentWriter::currentTimestamp($citingBook);
            $node = BookContentWriter::nodeRow($citingBook, (string) $request->get('citing_node_id'));
            if (! $node) {
                return Response::error('That citing_node_id was not found in the citing book — copy it from read_book output.');
            }

            $content = (string) $node->content;

            // Where does the insert land?
            $afterText = $afterTextInput;
            if ($afterText !== '') {
                $pos = strpos($content, $afterText);
                if ($pos === false) {
                    // The stored HTML may encode entities the plain text doesn't.
                    $encoded = e($afterText);
                    $pos = $encoded !== $afterText ? strpos($content, $encoded) : false;
                    $afterText = $encoded;
                }
                if ($pos === false) {
                    return Response::error('after_text was not found verbatim in that node\'s stored content. Use a snippet from the node as read_book returns it, or omit after_text to append at the end.');
                }
                $at = $pos + strlen($afterText);
            } else {
                // End of node: before the final closing tag if there is one.
                $at = preg_match('/^(.*)(<\/[a-z][a-z0-9]*>\s*)$/is', $content, $m)
                    ? strlen($m[1])
                    : strlen($content);
            }

            // NEVER two arrows in a row (the web archivist's rule, enforced
            // mechanically there too): a bare arrow landing against an existing
            // ↗ merges into ONE grouped arrow with a member chooser.
            $merged = false;
            if (! $insertQuote && ($adjacent = $this->adjacentArrowAt($content, $at)) !== null) {
                $mergedResult = $this->mergeIntoGroup($adjacent, $sourceBook, $sourceHyperciteId, $hypercitedText);
                if ($mergedResult instanceof Response) {
                    return $mergedResult;
                }
                $newContent = substr_replace($content, $mergedResult, $adjacent['offset'], strlen($adjacent['html']));
                $anchorId = $adjacent['id'];
                $merged = true;
            } else {
                // HyperciteMinter convention: the citing-side anchor gets its
                // OWN id, and the anchor HTML carries the U+2060 word joiner
                // the web lane emits. insert_quote reproduces the full
                // web-paste payload — '<verbatim>'↗ — with the SERVER
                // supplying the quoted text from the anchor itself, so the
                // quote cannot drift from the source passage.
                $anchorId = 'hypercite_'.Str::lower(Str::random(8));
                $arrow = "\u{2060}".'<a href="/'.e($sourceBook).'#'.e($sourceHyperciteId).'" id="'.e($anchorId).'" class="open-icon">↗</a>';
                // A quoted insert reads as prose — give it a space off the
                // preceding word; the bare arrow hugs its text like the web paste.
                $insert = $insertQuote ? ' \''.e($hypercitedText).'\''.$arrow : $arrow;
                $newContent = substr_replace($content, $insert, $at, 0);
            }

            // ── One transaction: citing node + cited row (citedIN read-merge-write)
            $citedIn = $baseCitedIn;
            $citedIn[] = '/'.$citingBook.'#'.$anchorId;

            $hyperciteItems = [[
                'book' => $sourceBook,
                'hyperciteId' => $sourceHyperciteId,
                'node_id' => $sourceNodeIds,
                'charData' => $sourceCharData,
                'hypercitedText' => $hypercitedText,
                'relationshipStatus' => 'couple',
                'citedIN' => array_values(array_unique($citedIn)),
                'time_since' => now()->getTimestamp(),
            ]];

            $write = BookContentWriter::sync(
                $user,
                $citingBook,
                [BookContentWriter::nodeItemFrom($node, $newContent)],
                $hyperciteItems,
                $baseTimestamp,
            );

            if ($write['ok'] || ($write['result']['error'] ?? null) !== 'STALE_DATA') {
                break;
            }
            // Someone else wrote the book between our read and our write —
            // loop: re-read, re-splice (the fresh content may now carry THEIR
            // arrow, which the adjacency merge then folds ours into), retry.
        }

        if (! $write['ok']) {
            return Response::error($write['error']);
        }

        $base = rtrim(config('app.url'), '/');

        return Response::json([
            'hypercite_id' => $sourceHyperciteId,
            'anchor_id' => $anchorId,
            'source_url' => $base.'/'.$sourceBook.'#'.$sourceHyperciteId,
            'citing_url' => $base.'/'.$citingBook.'#'.$anchorId,
            'message' => $merged
                ? 'Two-way hypercite completed: the splice point touched an existing ↗, so this citation was MERGED into it as a multi-source arrow (readers get a chooser). Stacked bare arrows are never emitted.'
                : 'Two-way hypercite completed: the source passage is underlined and cites back to your book; your node now carries the ↗ arrow.',
        ]);
    }

    /**
     * The open-icon anchor directly touching byte offset $at in $content —
     * ending at it (modulo whitespace / the U+2060 word joiner) or starting
     * there — or null when the insert lands against ordinary prose.
     *
     * @return array{html: string, offset: int, id: string, href: string, group: ?string}|null
     */
    private function adjacentArrowAt(string $content, int $at): ?array
    {
        $anchor = '<a\b[^>]*\bclass="[^"]*\bopen-icon\b[^"]*"[^>]*>(?:(?!<\/a>).)*<\/a>';

        $before = substr($content, 0, $at);
        if (preg_match('/('.$anchor.')[\s\x{2060}]*$/su', $before, $m, PREG_OFFSET_CAPTURE)) {
            return $this->parseArrow($m[1][0], $m[1][1]);
        }

        $after = substr($content, $at);
        if (preg_match('/^[\s\x{2060}]*('.$anchor.')/su', $after, $m, PREG_OFFSET_CAPTURE)) {
            return $this->parseArrow($m[1][0], $at + $m[1][1]);
        }

        return null;
    }

    /** @return array{html: string, offset: int, id: string, href: string, group: ?string}|null */
    private function parseArrow(string $html, int $offset): ?array
    {
        preg_match('/\bid="([^"]+)"/', $html, $id);
        preg_match('/\bhref="([^"]+)"/', $html, $href);
        preg_match('/\bdata-cite-group="([^"]*)"/', $html, $group);

        // An arrow we can't identify is left alone — the caller falls back to
        // a plain insert rather than mangling markup it doesn't understand.
        if (! isset($id[1], $href[1])) {
            return null;
        }

        return [
            'html' => $html,
            'offset' => $offset,
            'id' => $id[1],
            'href' => $href[1],
            'group' => isset($group[1]) ? html_entity_decode($group[1], ENT_QUOTES) : null,
        ];
    }

    /**
     * Rebuild the adjacent arrow as ONE grouped anchor carrying the existing
     * member(s) plus the new citation — the web archivist's data-cite-group
     * shape (AiBrainController), so the reader's chooser popover works on it.
     * The EXISTING anchor id becomes the group id (its member's citedIN
     * already points there), and the new member's citedIN joins it.
     *
     * Returns the replacement anchor HTML, or an error Response.
     */
    private function mergeIntoGroup(array $adjacent, string $sourceBook, string $sourceHyperciteId, string $hypercitedText): string|Response
    {
        if ($adjacent['group'] !== null) {
            $members = json_decode($adjacent['group'], true);
            if (! is_array($members)) {
                return Response::error('The adjacent ↗ carries a citation group this tool cannot parse — place this arrow after the clause it supports (after_text) instead of stacking it here.');
            }
        } else {
            $members = [[
                't' => $adjacent['href'],
                's' => $this->bookLabel(Str::before(ltrim($adjacent['href'], '/'), '#')),
                'q' => $this->quoteFor($adjacent['href']),
            ]];
        }

        $newTarget = '/'.$sourceBook.'#'.$sourceHyperciteId;
        if (collect($members)->contains(fn ($memberRow) => ($memberRow['t'] ?? null) === $newTarget)) {
            return Response::error('That exact source anchor is already cited by the adjacent ↗ — nothing to add.');
        }

        $members[] = [
            't' => $newTarget,
            's' => $this->bookLabel($sourceBook),
            'q' => Str::limit($hypercitedText, 140),
        ];

        return '<a id="'.e($adjacent['id']).'" href="'.e($adjacent['href']).'" class="open-icon"'
            .' data-cite-group="'.e(json_encode($members, JSON_UNESCAPED_UNICODE)).'">↗</a>';
    }

    /** "Title — Author" for the chooser rows, mirroring the web pipeline's label. */
    private function bookLabel(string $bookId): string
    {
        $row = DB::table('library')->where('book', $bookId)->first(['title', 'author']);

        $label = trim(((string) ($row->title ?? '')) !== '' ? (string) $row->title : 'Untitled');
        if ((string) ($row->author ?? '') !== '') {
            $label .= ' — '.$row->author;
        }

        return $label;
    }

    /** The anchored passage behind an existing arrow, for its chooser row. */
    private function quoteFor(string $href): string
    {
        $book = Str::before(ltrim($href, '/'), '#');
        $hyperciteId = Str::after($href, '#');
        if ($book === '' || $hyperciteId === '' || $hyperciteId === $href) {
            return '';
        }

        $text = DB::table('hypercites')
            ->where('book', $book)
            ->where('hyperciteId', $hyperciteId)
            ->value('hypercitedText');

        return Str::limit((string) ($text ?? ''), 140);
    }
}
