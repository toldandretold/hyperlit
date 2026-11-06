<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbHyperlightController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\Annotations\AnchorAmbiguousException;
use App\Services\Annotations\AnchorNotFoundException;
use App\Services\Annotations\AnnotationAnchorService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

#[IsIdempotent(false)]
class CreateHighlightTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'create_highlight';

    protected string $description = 'Highlight a passage in a book (a "hyperlight"), optionally with an annotation note. Pass the passage as a VERBATIM quote from read_book\'s plain output — the server anchors it by character offsets. If the quote appears more than once you get the match contexts back; retry with `occurrence`. Pass `suggested_replacement` to also propose an EDIT to the passage: the highlight becomes a pending suggestion the book owner can Accept (swapping the passage for your text), Decline, or Like — the book itself is never changed until they accept.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'quote' => $schema->string()->min(3)->required()
                ->description('The exact passage to highlight, quoted verbatim from read_book plain output. Whitespace differences are tolerated; wording differences are not.'),
            'annotation' => $schema->string()
                ->description('Optional note attached to the highlight (plain text; paragraphs separated by blank lines).'),
            'occurrence' => $schema->integer()
                ->description('1-based: which occurrence to highlight when the quote appears multiple times.'),
            'visibility' => $schema->string()->enum(['public', 'private'])
                ->description('Annotation visibility. private = only the user sees it. Default: public on the user\'s OWN books, private on books they do not own (so highlighting a public book stays personal and does not appear for other readers). A PRIVATE suggestion is invisible to the book owner — use public when proposing an edit on someone else\'s book.'),
            'suggested_replacement' => $schema->string()
                ->description('Optional: propose this text as a REPLACEMENT for the quoted passage (a suggested edit the book owner reviews). The quote must sit within ONE paragraph. Works on the user\'s own books too — there the user reviews/accepts it themselves (e.g. agent drafts, human approves).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'quote' => 'required|string|min:3',
            'occurrence' => 'nullable|integer|min:1',
            'visibility' => 'nullable|in:public,private',
            'suggested_replacement' => 'nullable|string|max:20000',
        ]);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        $nodes = $this->fetchNodes($bookId, $user);
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

        // Suggested-edit pre-flight — BEFORE anything is created, so a refusal
        // leaves no half-made highlight behind.
        $replacement = $request->get('suggested_replacement');
        $replacement = is_string($replacement) && trim($replacement) !== '' ? $replacement : null;
        if ($replacement !== null) {
            if (count($anchor['node_ids']) !== 1) {
                return Response::error(
                    'The quote spans '.count($anchor['node_ids']).' paragraphs — suggested edits anchor to ONE paragraph. Quote a passage within a single paragraph (or make one suggestion per paragraph).'
                );
            }
            if ($replacement === $anchor['highlightedText']) {
                return Response::error('The suggested replacement is identical to the quoted passage — nothing to suggest.');
            }
        }

        $hyperlightId = 'HL_'.now()->getTimestampMs();
        $record = [
            'book' => $bookId,
            'hyperlight_id' => $hyperlightId,
            'node_id' => $anchor['node_ids'],
            'charData' => $anchor['charData'],
            'highlightedText' => $anchor['highlightedText'],
            'annotation' => self::annotationHtml($request->get('annotation')),
            'startLine' => $anchor['startLine'],
            'time_since' => now()->getTimestamp(),
            'sub_book_visibility' => $this->resolveVisibility($request, $bookId, $user),
        ];

        $result = InternalCall::call(
            DbHyperlightController::class, 'upsert', ['data' => [$record]], $user
        );
        if ($error = $this->errorFrom($result, 'create the highlight')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'The highlight was not saved.');
        }

        // Attach the suggestion in a SECOND upsert: the sync-path guard
        // deliberately discards suggested_text on a brand-new row (a
        // suggestion only exists on an existing highlight), so create first,
        // then update. The guard derives status=pending server-side.
        $suggestionStatus = null;
        if ($replacement !== null) {
            $suggested = InternalCall::call(
                DbHyperlightController::class, 'upsert', ['data' => [array_merge($record, [
                    'suggested_text' => [
                        $anchor['node_ids'][0] => [
                            'before' => $anchor['highlightedText'],
                            'after' => $replacement,
                        ],
                    ],
                ])]], $user
            );
            if ($error = $this->errorFrom($suggested, 'attach the suggested edit')) {
                return $error;
            }
            $suggestionStatus = 'pending';
        }

        return Response::json(array_filter([
            'hyperlight_id' => $hyperlightId,
            'highlighted_text' => $anchor['highlightedText'],
            'suggestion_status' => $suggestionStatus,
            'url' => rtrim(config('app.url'), '/').'/'.$bookId.'#'.$hyperlightId,
        ]));
    }

    /**
     * Explicit visibility wins; otherwise default to PUBLIC on the user's own
     * book and PRIVATE on a book they don't own — so an agent highlighting a
     * public book for the user's research doesn't surface marks to every reader.
     */
    private function resolveVisibility(Request $request, string $bookId, \App\Models\User $user): string
    {
        $explicit = $request->get('visibility');
        if ($explicit === 'public' || $explicit === 'private') {
            return $explicit;
        }

        $owner = \Illuminate\Support\Facades\DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', \App\Services\E2ee\EncryptedBookGuard::rootBookId($bookId))
            ->value('creator');

        return ($owner !== null && $owner === $user->name) ? 'public' : 'private';
    }

    /** Plain-text annotation → the stored HTML shape (one <p> per blank-line paragraph). */
    public static function annotationHtml(?string $plain): ?string
    {
        $plain = trim((string) $plain);
        if ($plain === '') {
            return null;
        }

        return collect(preg_split('/\n{2,}/', $plain) ?: [])
            ->map(fn ($p) => '<p>'.nl2br(e(trim($p)), false).'</p>')
            ->implode('');
    }
}
