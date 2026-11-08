<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbLibraryController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Set a book's citation details (the "library card"). Owner only. Pair it with
 * lookup_citation_metadata to pull authoritative values from OpenAlex first,
 * or just infer them from the text yourself and set them here. Only provided
 * fields are changed.
 */
#[IsIdempotent]
class SetBookMetadataTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::IMPORT;

    protected string $name = 'set_book_metadata';

    protected string $description = 'Set a book\'s citation details (title, author, year, journal, volume, issue, pages, publisher, booktitle, editor, type, doi/url, note). Owner only; only the fields you pass are changed. Use after importing so the book has a proper citation. Combine with lookup_citation_metadata for authoritative values.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'title' => $schema->string()->description('Work title.'),
            'author' => $schema->string()->description('Author(s), "; "-separated.'),
            'year' => $schema->string()->description('Publication year.'),
            'type' => $schema->string()->description('article | book | incollection | inproceedings | phdthesis | misc …'),
            'journal' => $schema->string()->description('Journal name (for articles).'),
            'booktitle' => $schema->string()->description('Container book/proceedings title (for chapters).'),
            'editor' => $schema->string()->description('Editor(s).'),
            'publisher' => $schema->string()->description('Publisher.'),
            'volume' => $schema->string()->description('Volume.'),
            'issue' => $schema->string()->description('Issue/number.'),
            'pages' => $schema->string()->description('Page range, e.g. 8-14.'),
            'doi' => $schema->string()->description('DOI (bare, e.g. 10.5210/fm.v29i4.13637). Stored as a doi.org URL.'),
            'url' => $schema->string()->description('Canonical URL (ignored if doi is given).'),
            'note' => $schema->string()->description('Free-text note on the card.'),
        ];
    }

    private const FIELDS = ['title', 'author', 'year', 'type', 'journal', 'booktitle',
        'editor', 'publisher', 'volume', 'issue', 'pages', 'note'];

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string']);
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $data = ['book' => $bookId];
        foreach (self::FIELDS as $f) {
            $v = $request->get($f);
            if ($v !== null && trim((string) $v) !== '') {
                $data[$f] = (string) $v;
            }
        }
        $doi = trim((string) $request->get('doi', ''));
        if ($doi !== '') {
            $data['url'] = 'https://doi.org/'.ltrim($doi, '/');
        } elseif (trim((string) $request->get('url', '')) !== '') {
            $data['url'] = trim((string) $request->get('url'));
        }

        if (count($data) === 1) {
            return Response::error('Provide at least one metadata field to set.');
        }

        // Bump library.timestamp: it is the freshness signal every client compares
        // against its IndexedDB copy (and BookCache against its prerender). Without it
        // an MCP edit lands in Postgres while every open/returning browser keeps
        // showing the old card until its cache is wiped (prod 2026-11-07: /terms
        // retitled via MCP, only a private window saw it).
        $data['timestamp'] = (int) round(microtime(true) * 1000);

        $result = InternalCall::call(DbLibraryController::class, 'upsert', ['data' => $data], $this->user($request));

        // The controller NO-OPS non-owner writes with success:true and a
        // "only book owners" message rather than a 403 — surface that as a
        // refusal so a model never believes it changed someone else's card.
        $message = is_array($result['json']) ? (string) ($result['json']['message'] ?? '') : '';
        if ($result['status'] === 401 || $result['status'] === 403
            || stripos($message, 'only book owners') !== false
            || stripos($message, 'No changes applied') !== false) {
            return Response::error('Only the book\'s owner can set its citation details.');
        }
        if ($error = $this->errorFrom($result, 'set the citation details')) {
            return $error;
        }

        return Response::json([
            'book' => $bookId,
            'updated_fields' => array_values(array_diff(array_keys($data), ['book'])),
        ]);
    }
}
