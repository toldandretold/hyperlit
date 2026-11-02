<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BookAudioController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * One status surface for everything audio on a book: narration counts/cost,
 * the live generation progress beat, the packaged .m4b state, and (optionally)
 * the per-node MP3 manifest. Binary endpoints are returned as URLs — MCP never
 * streams audio bytes.
 */
#[IsReadOnly]
class GetAudiobookStatusTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_audiobook_status';

    protected string $description = 'Audio status for a book: how much is narrated, live generation progress (poll this after create_audiobook), the packaged .m4b state, playback/download URLs, and optionally the per-node MP3 manifest (include_manifest:true — can be large).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'include_manifest' => $schema->boolean()->description('true = include the per-node MP3 manifest (node_id → file, duration). Large books make this long.'),
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

        $user = $this->user($request);

        $status = InternalCall::call(BookAudioController::class, 'status', [], $user, [$bookId]);
        if ($error = $this->errorFrom($status, 'read the audiobook status')) {
            return $error;
        }
        $progress = InternalCall::call(BookAudioController::class, 'progress', [], $user, [$bookId]);
        $package = InternalCall::call(BookAudioController::class, 'audiobookStatus', [], $user, [$bookId]);

        $base = rtrim(config('app.url'), '/');
        $out = [
            'book' => $bookId,
            'narration' => $status['json'] ?? [],
            'progress' => $progress['json'] ?? null,
            'audiobook_package' => $package['json'] ?? null,
            'player_url' => $base.'/'.$bookId,
            'm4b_download_url' => $base.'/'.$bookId.'/audiobook.m4b',
            'node_mp3_url_pattern' => $base.'/'.$bookId.'/audio/{filename}',
        ];

        if ($request->boolean('include_manifest')) {
            $manifest = InternalCall::call(BookAudioController::class, 'manifest', [], $user, [$bookId]);
            $out['manifest'] = $manifest['json'] ?? null;
        }

        return Response::json($out);
    }
}
