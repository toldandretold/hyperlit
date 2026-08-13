<?php

namespace App\Services\CitationReview\Phases;

use App\Services\BackendHighlightService;
use App\Services\CitationReview\Support\SourceHtmlBuilder;
use App\Services\CitationReview\Support\SourceTypeClassifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Phase 6 of the citation review: turn each claim's verdict into a highlight on
 * the reviewed text, with a reasoning sub-book attached. Unresolved citations
 * get a distinct "Source Not Found" highlight. Clears prior AIreview highlights
 * first. Marks each highlighted claim with 'has_highlight' and returns the count.
 * Finally, flips the book's gate default so the highlights it just created are
 * actually VISIBLE (see revealAiHighlightsByDefault).
 *
 * Extracted verbatim from CitationReviewService::createVerificationHighlights.
 */
final class VerificationHighlighter
{
    /** Mirror of the client's GLOBAL_DEFAULT_FLAGS (components/utilities/gateFilter.ts). */
    private const GLOBAL_DEFAULT_FLAGS = [
        'hyperlight' => ['hideAI' => true,  'hideAnonymous' => false, 'hideNoAnnotation' => true],
        'hypercite'  => ['hideAI' => true,  'hideAnonymous' => true,  'hideNoAnnotation' => false],
    ];

    public function __construct(
        private BackendHighlightService $highlights,
        private SourceHtmlBuilder $sourceHtml,
    ) {}

    public function createVerificationHighlights(array &$claims, string $bookId): int
    {
        // Cleanup previous AI review highlights
        $this->highlights->deleteHighlightsByCreator($bookId, 'AIreview:');

        // Derive model name from config
        $rawModel = config('services.llm.verification_model') ?: config('services.llm.model', 'unknown');
        $modelName = basename($rawModel);
        $creator = "AIreview:{$modelName}";

        $count = 0;

        foreach ($claims as $key => $claim) {
            $verdict = $claim['llm_verdict'] ?? null;

            $nodeId      = $claim['node_id'];
            $refId       = $claim['referenceId'];
            $text        = $claim['truth_claim'];
            $charStart   = $claim['charStart'] ?? null;
            $charEnd     = $claim['charEnd'] ?? null;
            $highlightId = $claim['highlightId'] ?? 'HL_' . abs(crc32($nodeId . $refId));

            // --- "Source Not Found" highlight for unresolved citations ---
            if (($claim['verified_source'] ?? true) === false
                && $charStart !== null && $charEnd !== null
            ) {
                $bibText = strip_tags($claim['bib_citation'] ?? '(no bibliography entry)');

                $snfContent = [];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Verdict: Source Not Found</strong></p>',
                    'plainText' => 'Verdict: Source Not Found',
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Claim:</strong> ' . e($claim['contextualised_claim'] ?? $text) . '</p>',
                    'plainText' => 'Claim: ' . ($claim['contextualised_claim'] ?? $text),
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Bibliography entry:</strong> ' . e($bibText) . '</p>',
                    'plainText' => "Bibliography entry: {$bibText}",
                ];
                $sourceNode = $this->sourceHtml->build($claim);
                if ($sourceNode) {
                    $snfContent[] = [
                        'type'      => 'p',
                        'content'   => $sourceNode['content'],
                        'plainText' => $sourceNode['plainText'],
                    ];
                }
                if (SourceTypeClassifier::shouldBeIndexed($claim)) {
                    // A journal article is almost always indexed in OpenAlex /
                    // Semantic Scholar, so its absence is a stronger red flag than
                    // a missing book — the reference may be miscited or fabricated.
                    $explanation = '🚩 This citation is formatted as a journal article, yet it could not be found in any academic database (OpenAlex, Semantic Scholar, Open Library). Peer-reviewed journal articles are almost always indexed there, so its absence is a stronger warning sign — the reference may be miscited or fabricated. Human review strongly recommended.';
                } else {
                    $explanation = 'This source could not be found in any academic database (OpenAlex, Semantic Scholar, Open Library). This may be because it is not an academic work, is not professionally published, or uses a non-standard citation format. Human review recommended.';
                }
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Explanation:</strong> ' . e($explanation) . '</p>',
                    'plainText' => 'Explanation: ' . $explanation,
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><a href="/' . e($bookId) . '/AIreview#ref_' . e($highlightId) . '">See within full report</a></p>',
                    'plainText' => 'See within full report',
                ];

                // Color all <strong> tags purple (unverified)
                foreach ($snfContent as &$node) {
                    $node['content'] = str_replace('<strong>', '<strong style="color:#9b59b6">', $node['content']);
                }
                unset($node);

                $result = $this->highlights->createHighlight([
                    'bookId'         => $bookId,
                    'nodeId'         => $nodeId,
                    'text'           => $text,
                    'highlightId'    => $highlightId,
                    'creator'        => $creator,
                    'annotation'     => 'Source Not Found — ' . mb_substr($bibText, 0, 120),
                    'subBookContent' => $snfContent,
                    'subBookTitle'   => 'AI Review: Source Not Found',
                    'charStart'      => $charStart,
                    'charEnd'        => $charEnd,
                ]);

                if ($result !== null) {
                    $claims[$key]['has_highlight'] = true;
                    $count++;
                }
                continue;
            }

            // Skip claims with no verdict or insufficient evidence
            if (!$verdict || ($verdict['support'] ?? null) === 'insufficient') {
                continue;
            }

            // Skip claims where charData couldn't be computed
            if ($charStart === null || $charEnd === null) {
                Log::debug('Skipping highlight — charData not available', [
                    'nodeId' => $nodeId,
                    'refId'  => $refId,
                ]);
                continue;
            }

            // Build annotation text (short verdict for hover)
            $supportLabel = match ($verdict['support']) {
                'confirmed'  => 'Confirmed',
                'likely'     => 'Likely',
                'plausible'  => 'Plausible',
                'unlikely'   => 'Unlikely',
                'rejected'   => 'Rejected',
                default      => $verdict['support'],
            };
            $annotation = $supportLabel . ' — ' . mb_substr($verdict['summary'] ?? '', 0, 120);

            // Build sub-book content nodes
            $subBookContent = [];

            // Verdict color (matches the AIreview chart palette)
            $verdictColor = match ($verdict['support']) {
                'confirmed' => '#27ae60',
                'likely'    => '#a3d977',
                'plausible' => '#f1c40f',
                'unlikely'  => '#e67e22',
                'rejected'  => '#e74c3c',
                default     => '#9b59b6',
            };

            // Node 1: Verdict
            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><strong>Verdict: ' . e($supportLabel) . '</strong></p>',
                'plainText' => "Verdict: {$supportLabel}",
            ];

            // Node 2: Claim
            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><strong>Claim:</strong> ' . e($claim['contextualised_claim'] ?? $text) . '</p>',
                'plainText' => 'Claim: ' . ($claim['contextualised_claim'] ?? $text),
            ];

            // Node 3: Source info (with links)
            $sourceNode = $this->sourceHtml->build($claim);
            if ($sourceNode) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => $sourceNode['content'],
                    'plainText' => $sourceNode['plainText'],
                ];
            }

            // Node 4: Evidence type
            $evidenceType = $verdict['evidence_type'] ?? null;
            if ($evidenceType) {
                $evidenceLabel = match ($evidenceType) {
                    'abstract_only'     => 'Abstract only',
                    'abstract_passage'  => 'Abstract + source passages',
                    'passage_only'      => 'Source passages only',
                    'web_and_passages'  => 'Web page content (partial) + passages',
                    'web_only'          => 'Web page content (partial)',
                    'title_only'        => 'Title only (no abstract or passages)',
                    'none'              => 'No evidence',
                    default             => $evidenceType,
                };
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Evidence:</strong> ' . e($evidenceLabel) . '</p>',
                    'plainText' => "Evidence: {$evidenceLabel}",
                ];
            }

            // Node 5: Summary
            if (!empty($verdict['summary'])) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Summary:</strong> ' . e($verdict['summary']) . '</p>',
                    'plainText' => 'Summary: ' . $verdict['summary'],
                ];
            }

            // Node 6: Reasoning (concise field, NOT the raw thinking chain)
            if (!empty($verdict['reasoning'])) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Reasoning:</strong> ' . e($verdict['reasoning']) . '</p>',
                    'plainText' => 'Reasoning: ' . $verdict['reasoning'],
                ];
            }

            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><a href="/' . e($bookId) . '/AIreview#ref_' . e($highlightId) . '">See within full report</a></p>',
                'plainText' => 'See within full report',
            ];

            // Color all <strong> tags with the verdict color
            foreach ($subBookContent as &$node) {
                $node['content'] = str_replace('<strong>', '<strong style="color:' . $verdictColor . '">', $node['content']);
            }
            unset($node);

            $result = $this->highlights->createHighlight([
                'bookId'         => $bookId,
                'nodeId'         => $nodeId,
                'text'           => $text,
                'highlightId'    => $highlightId,
                'creator'        => $creator,
                'annotation'     => $annotation,
                'subBookContent' => $subBookContent,
                'subBookTitle'   => "AI Review: {$supportLabel}",
                'charStart'      => $charStart,
                'charEnd'        => $charEnd,
            ]);

            if ($result !== null) {
                $claims[$key]['has_highlight'] = true;
                $count++;
            }
        }

        if ($count > 0) {
            $this->revealAiHighlightsByDefault($bookId);
        }

        return $count;
    }

    /**
     * Flip this book's gate default so the AI review highlights are NOT hidden.
     *
     * The global default hides AI highlights (sensible for books nobody asked to have
     * reviewed) — but a book that HAS a citation review is a book whose owner wanted
     * one, and highlights nobody can see are worthless: the report links to them, and
     * a reader arriving at the book saw nothing. So running a review sets
     * `library.gate_defaults.hyperlight.hideAI = false` for that book only.
     *
     * This is a DEFAULT, not a lock: the owner flips it back any time via the gate
     * panel's "Save as Book Default" (or "Reset to Global Default"), and any reader's
     * own Custom / Hide All choice still outranks it. Only the hyperlight column is
     * touched — the hypercite column and every other flag are preserved as-is (legacy
     * FLAT gate_defaults are normalized to the per-type shape on the way through).
     */
    private function revealAiHighlightsByDefault(string $bookId): void
    {
        try {
            $db = DB::connection('pgsql_admin');
            $row = $db->table('library')->where('book', $bookId)->first(['gate_defaults']);
            if (!$row) return;

            $existing = $row->gate_defaults;
            if (is_string($existing)) $existing = json_decode($existing, true);
            if (!is_array($existing)) $existing = null;

            $defaults = [
                'hyperlight' => $this->normalizeFlags($existing, 'hyperlight'),
                'hypercite'  => $this->normalizeFlags($existing, 'hypercite'),
            ];

            if ($defaults['hyperlight']['hideAI'] === false) return; // already visible — no write

            $defaults['hyperlight']['hideAI'] = false;

            // Bump timestamp as well as annotations_updated_at: the client only reloads the
            // library row (which carries gate_defaults) on the CONTENT-changed branch of its
            // freshness check — an annotations-only sync would leave the stale defaults cached.
            $nowMs = (int) round(microtime(true) * 1000);
            $db->table('library')->where('book', $bookId)->update([
                'gate_defaults'          => json_encode($defaults),
                'timestamp'              => $nowMs,
                'annotations_updated_at' => $nowMs,
            ]);

            Log::info('Citation review made AI highlights visible by default for book', [
                'book' => $bookId,
                'gate_defaults' => $defaults,
            ]);
        } catch (\Throwable $e) {
            // Never fail a completed review over the visibility default — the highlights
            // exist either way and the owner can unhide them from the gate panel.
            Log::warning('Could not update gate_defaults after citation review', [
                'book' => $bookId,
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Normalize a nested-per-type OR legacy-flat gate_defaults object to one type's
     * flag triple, falling back to the global default for that type. Mirror of
     * DatabaseToIndexedDBController::normalizeGateFlags + the client's normalizeGateFlags.
     */
    private function normalizeFlags(?array $flags, string $type): array
    {
        if ($flags === null) return self::GLOBAL_DEFAULT_FLAGS[$type];

        if (array_key_exists('hyperlight', $flags) || array_key_exists('hypercite', $flags)) {
            $flags = $flags[$type] ?? null;
            if (!is_array($flags)) return self::GLOBAL_DEFAULT_FLAGS[$type];
        }

        return [
            'hideAI'           => (bool) ($flags['hideAI'] ?? false),
            'hideAnonymous'    => (bool) ($flags['hideAnonymous'] ?? false),
            'hideNoAnnotation' => (bool) ($flags['hideNoAnnotation'] ?? false),
        ];
    }
}
