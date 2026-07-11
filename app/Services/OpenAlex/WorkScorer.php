<?php

namespace App\Services\OpenAlex;

use Illuminate\Support\Facades\Log;

/**
 * Similarity + composite scoring between extracted citation metadata and a
 * candidate work. Pure computation (the only side effect is the diagnostic
 * metadataScore log line) — reusable across OpenAlex, Open Library and
 * Semantic Scholar candidates, all of which share the normalised shape.
 */
class WorkScorer
{
    /**
     * Strip diacritics to ASCII: "Aydın"→"Aydin", "Mbembé"→"Mbembe", etc.
     */
    private function asciiFold(string $s): string
    {
        if (function_exists('transliterator_transliterate')) {
            return transliterator_transliterate('Any-Latin; Latin-ASCII', $s);
        }
        $result = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        return $result !== false ? $result : $s;
    }

    /**
     * Lowercase, strip diacritics, remove punctuation, collapse whitespace.
     */
    private function normaliseText(string $s): string
    {
        $s = $this->asciiFold(mb_strtolower($s));
        $s = preg_replace('/[^\w\s]/u', ' ', $s);
        return preg_replace('/\s+/', ' ', trim($s));
    }

    /**
     * Compare two individual author names using word-set matching.
     * Handles reordering ("Nilsen, Alf Gunvald" vs "Alf Gunvald Nilsen")
     * and fuzzy tolerance via levenshtein().
     * Returns proportion of shorter name's words that matched (0.0–1.0).
     */
    private function nameSimilarity(string $name1, string $name2): float
    {
        $normalise = function (string $name): array {
            $name = $this->asciiFold(mb_strtolower($name));
            $name = preg_replace('/[,.\-]/u', ' ', $name);
            $words = preg_split('/\s+/', trim($name), -1, PREG_SPLIT_NO_EMPTY);
            // Remove initials (1-2 char tokens like "A", "AG", "CK")
            return array_values(array_filter($words, fn($w) => mb_strlen($w) > 2));
        };

        $words1 = $normalise($name1);
        $words2 = $normalise($name2);

        if (empty($words1) || empty($words2)) {
            return 0.0;
        }

        $shorter = count($words1) <= count($words2) ? $words1 : $words2;
        $longer  = count($words1) <= count($words2) ? $words2 : $words1;

        $matched = 0;
        $used = [];
        foreach ($shorter as $sw) {
            foreach ($longer as $li => $lw) {
                if (isset($used[$li])) continue;
                if ($sw === $lw || (mb_strlen($sw) >= 4 && mb_strlen($lw) >= 4 && levenshtein($sw, $lw) <= 1)) {
                    $matched++;
                    $used[$li] = true;
                    break;
                }
            }
        }

        return $matched / count($shorter);
    }

    /**
     * Compute blended word + character similarity between two titles.
     * Returns 0.0–1.0. Combines Jaccard word-overlap (structural) with
     * similar_text() percentage (typo tolerance), scaled by a length penalty.
     */
    public function titleSimilarity(string $query, string $resultTitle): float
    {
        $stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as'];

        $normQuery  = $this->normaliseText($query);
        $normResult = $this->normaliseText($resultTitle);

        if ($normQuery === '' || $normResult === '') {
            return 0.0;
        }

        // Word-level Jaccard
        $tokenise = function (string $text) use ($stopWords): array {
            $words = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
            return array_values(array_diff($words, $stopWords));
        };

        $queryWords  = $tokenise($normQuery);
        $resultWords = $tokenise($normResult);

        if (empty($queryWords) || empty($resultWords)) {
            return 0.0;
        }

        $intersection = count(array_intersect($queryWords, $resultWords));
        $union        = count(array_unique(array_merge($queryWords, $resultWords)));
        $jaccard      = $union > 0 ? $intersection / $union : 0.0;

        // Character-level similarity (typo tolerance)
        similar_text($normQuery, $normResult, $charSimPercent);
        $charSim = $charSimPercent / 100.0;

        // Blend: 60% word-level, 40% character-level
        $blended = 0.6 * $jaccard + 0.4 * $charSim;

        // Length penalty: min/max word count ratio scaled 0.5–1.0
        $lengthRatio = min(count($queryWords), count($resultWords))
                     / max(count($queryWords), count($resultWords));

        return $blended * (0.5 + 0.5 * $lengthRatio);
    }

    /**
     * Compute a composite metadata score between LLM-extracted metadata and a candidate.
     * Weights: title 0.55, author 0.25, year 0.10, journal 0.05, publisher 0.05. Returns 0.0–1.0.
     */
    public function metadataScore(array $llmMeta, array $candidate): array
    {
        // Title similarity (weight 0.55)
        $titleScore = $this->titleSimilarity(
            $llmMeta['title'] ?? '',
            $candidate['title'] ?? ''
        );

        // Title floor: if the title doesn't remotely match, hard reject regardless of author/year
        if ($titleScore < 0.15) {
            return [
                'score'           => 0.0,
                'titleScore'      => round($titleScore, 4),
                'reason'          => 'title_floor',
            ];
        }

        // Author match (weight 0.25): proportional matching via nameSimilarity
        $authorScore = 0.0;
        $llmAuthors = $llmMeta['authors'] ?? [];
        // Strip "et al." — it inflates the denominator and never matches a real name
        $llmAuthors = array_values(array_filter($llmAuthors, function ($a) {
            $normalised = mb_strtolower(trim($a));
            return $normalised !== 'et al.' && $normalised !== 'et al' && $normalised !== 'etal';
        }));
        $candidateAuthor = $candidate['author'] ?? '';

        if (!empty($llmAuthors) && !empty($candidateAuthor)) {
            // Split candidate authors by semicolons into individual names
            $candidateNames = array_map('trim', explode(';', $candidateAuthor));
            $candidateNames = array_values(array_filter($candidateNames, fn($n) => strlen($n) >= 2));

            $matchedCount = 0;
            $usedCandidates = [];

            foreach ($llmAuthors as $llmAuthor) {
                $bestNameScore = 0.0;
                $bestIdx = -1;

                foreach ($candidateNames as $ci => $cName) {
                    if (isset($usedCandidates[$ci])) continue;
                    $ns = $this->nameSimilarity($llmAuthor, $cName);
                    if ($ns > $bestNameScore) {
                        $bestNameScore = $ns;
                        $bestIdx = $ci;
                    }
                }

                if ($bestNameScore >= 0.6 && $bestIdx >= 0) {
                    $matchedCount++;
                    $usedCandidates[$bestIdx] = true;
                }
            }

            $authorScore = count($llmAuthors) > 0 ? (float)($matchedCount / count($llmAuthors)) : 0.0;
        }

        // Year match (weight 0.12): 1.0 exact, 0.5 if ±1, 0.0 otherwise
        // Check against both year and original_year; take the best score
        $yearScore = 0.0;
        $candidateYear = $candidate['year'] ?? null;
        $yearsToCheck = array_filter([
            $llmMeta['year'] ?? null,
            $llmMeta['original_year'] ?? null,
        ], fn($v) => $v !== null);
        if ($candidateYear !== null) {
            foreach ($yearsToCheck as $y) {
                $diff = abs((int) $y - (int) $candidateYear);
                if ($diff === 0) {
                    $yearScore = 1.0;
                    break;
                } elseif ($diff === 1 && $yearScore < 0.5) {
                    $yearScore = 0.5;
                }
            }
        }

        // Journal bonus (weight 0.05): similar_text comparison
        $journalScore = 0.0;
        $llmJournal = $llmMeta['journal'] ?? '';
        $candidateJournal = $candidate['journal'] ?? '';
        if (strlen($llmJournal) >= 3 && strlen($candidateJournal) >= 3) {
            $normLlmJournal  = $this->normaliseText($llmJournal);
            $normCandJournal = $this->normaliseText($candidateJournal);
            similar_text($normLlmJournal, $normCandJournal, $journalSimPercent);
            $journalSim = $journalSimPercent / 100.0;
            $journalScore = $journalSim >= 0.4 ? $journalSim : 0.0;
        }

        // Publisher comparison (weight 0.05): bonus only — no penalty if missing
        $publisherScore = 0.0;
        $llmPublisher = $llmMeta['publisher'] ?? '';
        $candidatePublisher = $candidate['publisher'] ?? '';
        if (strlen($llmPublisher) >= 3 && strlen($candidatePublisher) >= 3) {
            $normLlmPub  = $this->normaliseText($llmPublisher);
            $normCandPub = $this->normaliseText($candidatePublisher);
            similar_text($normLlmPub, $normCandPub, $pubSimPercent);
            $pubSim = $pubSimPercent / 100.0;
            $publisherScore = $pubSim >= 0.4 ? $pubSim : 0.0;
        }

        // Author mismatch penalty
        $authorMismatchPenalty = 1.0;
        if ($authorScore === 0.0 && !empty($llmAuthors)) {
            if (!empty($candidateAuthor)) {
                // Both sides have authors, none match → hard reject
                return [
                    'score'            => 0.0,
                    'titleScore'       => round($titleScore, 4),
                    'authorScore'      => 0.0,
                    'yearScore'        => $yearScore,
                    'journalScore'     => round($journalScore, 4),
                    'publisherScore'   => round($publisherScore, 4),
                    'authorPenalty'    => 0.0,
                    'rawScore'         => 0.0,
                    'llmAuthors'       => $llmAuthors,
                    'candidateAuthor'  => $candidateAuthor,
                    'reason'           => 'author_hard_reject',
                ];
            } else {
                $authorMismatchPenalty = 0.85;  // candidate has no author data
            }
        } elseif ($authorScore > 0.0 && $authorScore < 0.5 && !empty($llmAuthors)) {
            // Partial but weak match: graduated penalty
            $authorMismatchPenalty = 0.7 + 0.6 * $authorScore;
        } elseif (empty($llmAuthors) && !empty($candidateAuthor)) {
            // LLM extracted no authors but candidate has specific author.
            // Can't confirm or deny — apply penalty.
            $authorMismatchPenalty = 0.75;
        }

        $rawScore = ($titleScore * 0.55) + ($authorScore * 0.25) + ($yearScore * 0.10) + ($journalScore * 0.05) + ($publisherScore * 0.05);
        $finalScore = $rawScore * $authorMismatchPenalty;

        $breakdown = [
            'score'            => $finalScore,
            'titleScore'       => round($titleScore, 4),
            'authorScore'      => round($authorScore, 4),
            'yearScore'        => $yearScore,
            'journalScore'     => round($journalScore, 4),
            'publisherScore'   => round($publisherScore, 4),
            'authorPenalty'    => round($authorMismatchPenalty, 4),
            'rawScore'         => round($rawScore, 4),
            'llmAuthors'       => $llmAuthors,
            'candidateAuthor'  => $candidateAuthor,
        ];

        Log::info('metadataScore', $breakdown);

        return $breakdown;
    }

    /**
     * Check whether a normalised work is a real citable work (not paratext, component, etc.).
     */
    public function isCitableWork(array $normalised): bool
    {
        $citableTypes = [
            'journal-article', 'article', 'book', 'book-chapter',
            'dissertation', 'proceedings-article', 'report',
            'peer-review', 'monograph', 'reference-entry',
            'proceedings', 'standard', 'posted-content',
            'edited-book',
        ];

        $type = $normalised['type'] ?? null;

        return $type !== null && in_array($type, $citableTypes, true);
    }
}
