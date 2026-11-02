<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DocuverseController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * The docuverse graph around ONE book. `focus` is REQUIRED on purpose: the
 * global graph is a visualization payload sized for the 3D view, not for a
 * context window — and even a focused component is truncated here if huge.
 */
#[IsReadOnly]
class GetCitationGraphTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_citation_graph';

    protected string $description = 'The citation/hypercite graph NEIGHBOURHOOD of one book (its connected component in the docuverse): nodes (books) + edges (hypercites, verified citations, auto-matched citations). Requires focus (a book). RLS-scoped — only books the user may see.';

    private const MAX_NODES = 200;

    private const MAX_EDGES = 600;

    public function schema(JsonSchema $schema): array
    {
        return [
            'focus' => $schema->string()->required()->description('The book (id or slug) whose network to return.'),
            'layers' => $schema->string()
                ->description('Comma-separated edge kinds: hypercite,citation_verified,citation_auto. Default: all three.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['focus' => 'required|string']);
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('focus'));
        if ($refusal) {
            return $refusal;
        }

        $input = ['focus' => $bookId];
        if (trim((string) $request->get('layers', '')) !== '') {
            $input['layers'] = trim((string) $request->get('layers'));
        }

        $result = InternalCall::call(DocuverseController::class, 'data', $input, $this->user($request));
        if ($error = $this->errorFrom($result, 'read the citation graph')) {
            return $error;
        }
        $json = $result['json'] ?? [];

        $nodes = $json['nodes'] ?? [];
        $edges = $json['edges'] ?? [];
        $truncated = false;
        if (count($nodes) > self::MAX_NODES) {
            $nodes = array_slice($nodes, 0, self::MAX_NODES);
            $truncated = true;
        }
        if (count($edges) > self::MAX_EDGES) {
            $edges = array_slice($edges, 0, self::MAX_EDGES);
            $truncated = true;
        }

        return Response::json([
            'focus' => $bookId,
            'layers' => $json['layers'] ?? null,
            'nodes' => $nodes,
            'edges' => $edges,
            'truncated' => $truncated,
            'graph_url' => rtrim(config('app.url'), '/').'/3d',
        ]);
    }
}
