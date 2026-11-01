<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\CitationScannerController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Start Hyperlit's AI Citation Review on a book — it extracts claims, resolves
 * each citation's source, fetches/grades the source text, and judges whether
 * it supports the claim, writing a report sub-book at {book}/AIreview.
 *
 * It's a LONG async job (minutes to hours). Returns a pipeline_id; poll with
 * get_citation_review for progress and the finished report.
 *
 * use_my_model = run the LLM analysis on the CALLER'S model (free — the user's
 * own tokens) via the claim_review_work/submit_review_verdict loop, instead of
 * Hyperlit's default model. Source fetching (OCR, browser, web search) still
 * runs on Hyperlit's infrastructure and is billed either way, so this needs
 * the spend ability and a positive balance in both modes.
 */
#[IsIdempotent(false)]
class RunCitationReviewTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::SPEND;

    protected string $name = 'run_citation_review';

    protected string $description = 'Start an AI Citation Review on a book (checks whether each citation\'s source actually supports the claim). Long async job — returns a pipeline_id; poll get_citation_review. set use_my_model=true to run the analysis on YOUR model for free via claim_review_work/submit_review_verdict (only source-fetching infra is billed, so a balance is still required).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'use_my_model' => $schema->boolean()
                ->description('Run the LLM analysis on the caller\'s own model (free) instead of Hyperlit\'s. Default false. If true, you must drain claim_review_work/submit_review_verdict while it runs.'),
            'force' => $schema->boolean()->description('Re-run even if a review already exists. Default false.'),
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

        $useMyModel = (bool) $request->get('use_my_model', false);

        // If a paused/failed review exists for this book, RESUME it instead of
        // starting a new one — "run it again" is how a model continues a BYO
        // review that paused (already-answered prompts replay from dedup).
        if (! $request->get('force', false)) {
            $existing = $this->latestPipeline($bookId);
            if ($existing && in_array($existing->status, ['paused', 'failed'], true)) {
                $resume = InternalCall::call(
                    CitationScannerController::class, 'resumePipeline', [], $this->user($request), [$existing->id]
                );
                if ($resume['status'] === 402) {
                    return Response::error('Insufficient balance to resume — top up in Account → Money.');
                }
                if (($resume['json']['success'] ?? false) === true) {
                    $wasClient = ($existing->inference_mode ?? null) === 'client';
                    $out = [
                        'book' => $bookId,
                        'pipeline_id' => $existing->id,
                        'resumed' => true,
                        'using_my_model' => $wasClient,
                        'next' => 'Poll get_citation_review('.$bookId.'); it continues where it left off.',
                    ];
                    if ($wasClient) {
                        $out['byo_instructions'] = 'Resumed — keep draining: claim_review_work → answer → submit_review_verdict. When claim_review_work comes back empty, poll get_citation_review: "paused" is the NORMAL rhythm (the job waits a few minutes for answers, then checkpoints) — just call this tool again to continue; nothing answered is ever re-asked. Repeat until it reports completed. Claimed prompts expire in ~15 minutes.';
                    }

                    return Response::json($out);
                }
                // Resume failed → fall through to a fresh trigger.
            }
        }

        $result = InternalCall::call(CitationScannerController::class, 'triggerPipeline', [
            'book' => $bookId,
            'client_inference' => $useMyModel,
            'force' => (bool) $request->get('force', false),
        ], $this->user($request));

        if ($result['status'] === 402) {
            return Response::error('Insufficient balance. Citation review bills source-fetching infrastructure (OCR, browser, web search) even when using your own model — top up in Account → Money.');
        }
        if ($result['status'] === 409) {
            return Response::error('A citation review is already running for this book — poll get_citation_review, or pass force:true to restart.');
        }
        if ($error = $this->errorFrom($result, 'start the citation review')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'The review was not started.');
        }

        $out = [
            'book' => $bookId,
            'pipeline_id' => $result['json']['pipeline_id'] ?? null,
            'using_my_model' => $useMyModel,
            'next' => 'Poll get_citation_review('.$bookId.') for progress and the finished report.',
        ];
        if ($useMyModel) {
            $out['byo_instructions'] = 'This review will park its analysis prompts for YOU to answer. Loop: call claim_review_work, answer each returned prompt, call submit_review_verdict for each, and repeat. When claim_review_work comes back empty, poll get_citation_review: a "paused" status is the NORMAL rhythm of this mode (the job waits a few minutes for answers, then checkpoints and parks) — call run_citation_review again to continue; answered prompts are never re-asked. Repeat the whole loop until get_citation_review reports "completed". Claimed prompts expire in ~15 minutes.';
        }

        return Response::json($out);
    }
}
