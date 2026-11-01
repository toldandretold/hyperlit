<?php

namespace App\Mcp\Tools;

use App\Helpers\BookSlugHelper;
use App\Http\Controllers\CitationScannerController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\Export\BookMarkdownExporter;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Check an AI Citation Review: while running, returns status/progress; when
 * finished, returns the report (the {book}/AIreview sub-book) as Markdown.
 */
#[IsReadOnly]
class GetCitationReviewTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_citation_review';

    protected string $description = 'Get the status and result of a book\'s AI Citation Review. While running: returns the current stage. When finished: returns the full report (per-claim verdicts: confirmed/likely/plausible/unlikely/rejected/broken-source). Poll this after run_citation_review.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'offset' => $schema->integer()->description('Report character offset to continue from (reports can be long). Default 0.'),
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

        $running = InternalCall::call(
            CitationScannerController::class, 'pipelineRunning', [], $this->user($request), [$bookId], [], false
        );
        $json = is_array($running['json']) ? $running['json'] : [];
        $reviewExists = (bool) ($json['ai_review_exists'] ?? false);
        // pipelineRunning only exposes ACTIVE pipelines; read the latest row
        // (any status) so paused/failed are visible, not reported as "none".
        $pipeline = $this->latestPipeline($bookId);
        $status = $pipeline->status ?? null;

        // A finished review exists → return the report (even if a later re-run
        // is now queued, the readable report is the latest completed one).
        if ($reviewExists && ! in_array($status, ['pending', 'running', 'paused'], true)) {
            return $this->report($request, $bookId);
        }

        if (in_array($status, ['pending', 'running'], true)) {
            return Response::json([
                'book' => $bookId,
                'status' => $status,
                'current_step' => $pipeline->current_step ?? null,
                'step_detail' => $pipeline->step_detail ?? null,
                'report_ready' => false,
            ]);
        }

        if ($status === 'paused') {
            // In BYO (use_my_model) mode a pause is the NORMAL rhythm, not an
            // error: the job waits ~5 minutes for ticket answers, and an agent
            // reasoning over a batch routinely takes longer. Say so, or the
            // caller reads a healthy run as a failure.
            $byo = ($pipeline->inference_mode ?? null) === 'client';
            return Response::json([
                'book' => $bookId,
                'status' => 'paused',
                'current_step' => $pipeline->current_step ?? null,
                'report_ready' => false,
                'note' => $byo
                    ? 'Paused — this is the NORMAL rhythm of a use_my_model review, not an error: the job waits a few minutes for your answers, then parks and checkpoints. Continue the loop: run_citation_review (resumes where it left off; answered prompts are never re-asked) → claim_review_work → answer → submit_review_verdict → when claims come back empty, poll this tool; if paused again, resume again. Repeat until status is completed.'
                    : 'The review paused (it was waiting on analysis answers that didn\'t arrive in time). Resume it by calling run_citation_review again — it continues where it left off (already-answered prompts are not re-asked).',
            ]);
        }

        if ($status === 'failed') {
            return Response::json([
                'book' => $bookId,
                'status' => 'failed',
                'error' => $pipeline->error ?? null,
                'report_ready' => $reviewExists,
                'note' => 'The review failed. You can retry with run_citation_review (force:true).',
            ]);
        }

        if (! $reviewExists) {
            return Response::json([
                'book' => $bookId,
                'status' => 'none',
                'report_ready' => false,
                'note' => 'No citation review found. Start one with run_citation_review.',
            ]);
        }

        return $this->report($request, $bookId);
    }

    private function report(Request $request, string $bookId): Response
    {
        // Finished → return the report sub-book markdown, paginated.
        $reviewBook = BookSlugHelper::resolve($bookId).'/AIreview';
        try {
            $markdown = app(BookMarkdownExporter::class)->markdownFor($reviewBook);
        } catch (\Throwable $e) {
            return Response::error('The review is complete but its report could not be read: '.$e->getMessage());
        }

        $total = mb_strlen($markdown);
        $offset = max(0, (int) $request->get('offset', 0));
        $slice = mb_substr($markdown, $offset, self::CHAR_BUDGET);
        $nextOffset = $offset + mb_strlen($slice);

        return Response::json([
            'book' => $bookId,
            'status' => 'completed',
            'report_ready' => true,
            'report_markdown' => $slice,
            'report_url' => rtrim(config('app.url'), '/').'/'.$bookId.'/AIreview',
            'total_chars' => $total,
            'next_offset' => $nextOffset < $total ? $nextOffset : null,
        ]);
    }
}
