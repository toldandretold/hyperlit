<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BookAudioController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Free: presses the already-narrated per-node MP3s into one chaptered .m4b
 * (BuildAudiobookJob, audio-package queue; cache keyed by the ordered file
 * digest so re-presses of an unchanged narration are instant).
 */
#[IsIdempotent]
class PackageAudiobookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'package_audiobook';

    protected string $description = 'Build the whole-book .m4b audiobook file (chapters from the book\'s headings) from already-generated narration. FREE — requires the book to have narration (create_audiobook first). Runs in the background; poll get_audiobook_status for the package state and download URL.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
        ];
    }

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

        $result = InternalCall::call(BookAudioController::class, 'buildAudiobook', [], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, 'package the audiobook')) {
            return $error;
        }
        $json = $result['json'] ?? [];
        if (($json['supported'] ?? true) === false) {
            return Response::error('Packaging is unavailable for this book: '.($json['reason'] ?? 'unsupported').'.');
        }

        return Response::json([
            'book' => $bookId,
            'state' => $json['state'] ?? null,
            'detail' => $json,
            'next' => 'Poll get_audiobook_status('.$bookId.') — when the package is ready it includes the .m4b download URL.',
        ]);
    }
}
