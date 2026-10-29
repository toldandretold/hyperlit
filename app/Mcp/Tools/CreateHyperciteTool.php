<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbHyperciteController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\Annotations\AnchorAmbiguousException;
use App\Services\Annotations\AnchorNotFoundException;
use App\Services\Annotations\AnnotationAnchorService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

#[IsIdempotent(false)]
class CreateHyperciteTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'create_hypercite';

    protected string $description = 'A hypercite is a TWO-WAY citation link (underlined source passage <-> arrow marker in the citing book). This tool creates ONLY the SOURCE-side citable anchor on a passage and returns its deep link + the ready-to-paste citation payload (arrow HTML). Completing the two-way link means pasting that into your own book, which needs book editing (not available here). Quote the passage VERBATIM from read_book plain output.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('The CITED book\'s id (book_…) or URL slug.'),
            'quote' => $schema->string()->min(3)->required()
                ->description('The exact passage to make citable, quoted verbatim from read_book plain output.'),
            'occurrence' => $schema->integer()
                ->description('1-based: which occurrence to anchor when the quote appears multiple times.'),
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

        // Client mint shape: "hypercite_" + 7 base36 chars. Fresh with no
        // citing documents yet → relationshipStatus 'single', citedIN [].
        $hyperciteId = 'hypercite_'.Str::lower(Str::random(7));
        $record = [
            'book' => $bookId,
            'hyperciteId' => $hyperciteId,
            'node_id' => $anchor['node_ids'],
            'charData' => $anchor['charData'],
            'hypercitedText' => $anchor['highlightedText'],
            'relationshipStatus' => 'single',
            'citedIN' => [],
            'time_since' => now()->getTimestamp(),
        ];

        $result = InternalCall::call(
            DbHyperciteController::class, 'upsert', ['data' => [$record]], $user
        );
        if ($error = $this->errorFrom($result, 'create the hypercite')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'The hypercite was not saved.');
        }

        $url = rtrim(config('app.url'), '/').'/'.$bookId.'#'.$hyperciteId;

        return Response::json([
            'hypercite_id' => $hyperciteId,
            'hypercited_text' => $anchor['highlightedText'],
            'url' => $url,
            'citation_html' => '\''.e($anchor['highlightedText']).'\'<a href="'.$url.'" class="open-icon">↗</a>',
        ]);
    }
}
