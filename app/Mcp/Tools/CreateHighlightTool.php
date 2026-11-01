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

    protected string $description = 'Highlight a passage in a book (a "hyperlight"), optionally with an annotation note. Pass the passage as a VERBATIM quote from read_book\'s plain output — the server anchors it by character offsets. If the quote appears more than once you get the match contexts back; retry with `occurrence`.';

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
                ->description('Annotation visibility. private = only the user sees it. Default: public on the user\'s OWN books, private on books they do not own (so highlighting a public book stays personal and does not appear for other readers).'),
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

        return Response::json([
            'hyperlight_id' => $hyperlightId,
            'highlighted_text' => $anchor['highlightedText'],
            'url' => rtrim(config('app.url'), '/').'/'.$bookId.'#'.$hyperlightId,
        ]);
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
