<?php

namespace App\Services\CitationStudy;

use RuntimeException;

/**
 * Loads and validates a study corpus manifest (study/corpora/{corpus}/manifest.json).
 *
 * A corpus is the unit of scientific bookkeeping: a named set of books with
 * per-citation ground-truth labels, frozen (hash-locked) before any run whose
 * numbers get reported. Book arms: 'synthetic' (real article with injected
 * corruptions), 'retracted' (real retracted paper, hand-labelled), 'control'
 * (verified-clean article).
 */
class CorpusManifest
{
    public const ARMS = ['synthetic', 'retracted', 'control'];

    /**
     * Import pathways a corpus book can arrive through — the SAME routes a
     * real user's document takes. The citation review is downstream of
     * conversion, so results are only interpretable when tagged with the
     * pathway that produced the text ("scores X via HTML, Y via markdown").
     * 'paste' = a captured clipboard payload run through the paste engine
     * (scripts/paste-convert.mjs), the path publisher-page pastes take.
     */
    public const PATHWAYS = ['pdf', 'markdown', 'html', 'docx', 'epub', 'paste'];

    /** source_file extension → default pathway (explicit `pathway` key wins). */
    private const EXT_PATHWAYS = [
        'pdf' => 'pdf',
        'html' => 'html', 'htm' => 'html',
        'md' => 'markdown', 'markdown' => 'markdown',
        'docx' => 'docx', 'doc' => 'docx', 'odt' => 'docx', 'rtf' => 'docx',
        'epub' => 'epub',
    ];

    public const LABELS = [
        'intact', 'verified_intact',
        'fabricated_reference', 'source_swap', 'claim_distortion',
        // Non-scored (outside POSITIVE/NEGATIVE → descriptive only):
        // 'not_a_citation' = the reviewed pairing does not exist in the
        // author's text — a phantom/mislinked anchor (chacko c130: a year
        // range minted into a citation) or a non-citation footnote. There is
        // nothing to verify, so neither an AI flag nor a pass can be scored.
        'suspect', 'unverifiable', 'not_a_citation',
    ];

    // Ground-truth labels counted as positives (should be flagged by the tool).
    public const POSITIVE_LABELS = ['fabricated_reference', 'source_swap', 'claim_distortion'];

    // Labels counted as negatives (should pass review).
    public const NEGATIVE_LABELS = ['intact', 'verified_intact'];

    private function __construct(
        public readonly string $corpus,
        public readonly string $dir,
        public readonly array $manifest,
    ) {}

    public static function load(string $corpus): self
    {
        if (!preg_match('/^[a-zA-Z0-9_-]+$/', $corpus)) {
            throw new RuntimeException("Invalid corpus name: {$corpus}");
        }
        $dir = base_path(config('study.root', 'study') . "/corpora/{$corpus}");
        $path = "{$dir}/manifest.json";
        if (!is_file($path)) {
            throw new RuntimeException("Corpus manifest not found: {$path}");
        }
        $manifest = json_decode((string) file_get_contents($path), true);
        if (!is_array($manifest)) {
            throw new RuntimeException("Corpus manifest is not valid JSON: {$path}");
        }

        $self = new self($corpus, $dir, $manifest);
        $self->validate();
        return $self;
    }

    private function validate(): void
    {
        $books = $this->manifest['books'] ?? null;
        if (!is_array($books) || $books === []) {
            throw new RuntimeException("Corpus '{$this->corpus}': manifest has no books.");
        }
        $seen = [];
        foreach ($books as $i => $book) {
            $slug = $book['slug'] ?? null;
            if (!$slug || !preg_match('/^[a-zA-Z0-9_-]+$/', $slug)) {
                throw new RuntimeException("Corpus '{$this->corpus}': book #{$i} has a missing or invalid slug.");
            }
            if (isset($seen[$slug])) {
                throw new RuntimeException("Corpus '{$this->corpus}': duplicate slug '{$slug}'.");
            }
            $seen[$slug] = true;
            $arm = $book['arm'] ?? null;
            if (!in_array($arm, self::ARMS, true)) {
                throw new RuntimeException("Corpus '{$this->corpus}': book '{$slug}' has invalid arm '{$arm}'.");
            }
            if (empty($book['source_file'])) {
                throw new RuntimeException("Corpus '{$this->corpus}': book '{$slug}' is missing source_file.");
            }
            $default = $book['default_label'] ?? 'intact';
            if (!in_array($default, self::LABELS, true)) {
                throw new RuntimeException("Corpus '{$this->corpus}': book '{$slug}' has invalid default_label '{$default}'.");
            }
            if ($arm === 'synthetic' && empty($book['corruption_spec'])) {
                throw new RuntimeException("Corpus '{$this->corpus}': synthetic book '{$slug}' needs a corruption_spec.");
            }
            if (isset($book['pathway']) && !in_array($book['pathway'], self::PATHWAYS, true)) {
                throw new RuntimeException(
                    "Corpus '{$this->corpus}': book '{$slug}' has invalid pathway '{$book['pathway']}' "
                    . '(one of: ' . implode(', ', self::PATHWAYS) . ').'
                );
            }
        }
    }

    /**
     * The import pathway for a book: the explicit `pathway` key, else derived
     * from the source_file extension. Books predating pathway tagging derive
     * cleanly (they are all .md/.html).
     */
    public function pathwayFor(array $book): string
    {
        if (isset($book['pathway'])) {
            return $book['pathway'];
        }
        $ext = strtolower(pathinfo($book['source_file'] ?? '', PATHINFO_EXTENSION));
        return self::EXT_PATHWAYS[$ext] ?? 'markdown';
    }

    /** @return array[] raw book entries from the manifest */
    public function books(): array
    {
        return $this->manifest['books'];
    }

    public function book(string $slug): array
    {
        foreach ($this->books() as $book) {
            if ($book['slug'] === $slug) {
                return $book;
            }
        }
        throw new RuntimeException("Corpus '{$this->corpus}': no book with slug '{$slug}'.");
    }

    public function isFrozen(): bool
    {
        return (bool) ($this->manifest['frozen'] ?? false);
    }

    /** Deterministic library book id for a corpus book. */
    public function bookIdFor(string $slug): string
    {
        return "study_{$this->corpus}_{$slug}";
    }

    /** Absolute path of a manifest-relative file reference. */
    public function path(string $relative): string
    {
        return "{$this->dir}/{$relative}";
    }

    /** The markdown file that actually gets imported (corrupted variant if present). */
    public function studyFile(array $book): string
    {
        return $this->path($book['study_file'] ?? $book['source_file']);
    }

    public function groundTruthPath(array $book): string
    {
        $rel = $book['ground_truth'] ?? "sources/{$book['slug']}/ground_truth.json";
        return $this->path($rel);
    }

    public function loadGroundTruth(array $book): array
    {
        $path = $this->groundTruthPath($book);
        if (!is_file($path)) {
            throw new RuntimeException("Ground truth missing for '{$book['slug']}': {$path}");
        }
        $gt = json_decode((string) file_get_contents($path), true);
        if (!is_array($gt) || !isset($gt['entries'])) {
            throw new RuntimeException("Ground truth invalid for '{$book['slug']}': {$path}");
        }
        return $gt;
    }

    /**
     * Save ground truth, CARRYING OVER any existing bindings for entries whose
     * text is unchanged. Regeneration must never silently un-bind an imported
     * book: the bindings are what the report joins on, and a wiped binding
     * turns every citation into a phantom "missed" row.
     *
     * HUMAN EVIDENCE rides the same carry-over, for the same reason and a
     * sharper one: the corruptor builds each entry as a fixed literal in seven
     * places, so a hand-added field would be erased the next time
     * `citation:study:corrupt` ran — destroying quotations a person typed. This
     * is the single write path for every generation route (corrupt, skeleton,
     * skeletonFromImportedRows, skeletonFromFootnotes), so protecting it here
     * protects all of them without touching any literal.
     */
    public function saveGroundTruth(array $book, array $groundTruth): void
    {
        $path = $this->groundTruthPath($book);

        // Fields a HUMAN authored, which no generator can reproduce.
        $humanFields = ['evidence', 'evidence_locator', 'evidenced_by', 'evidenced_at'];

        // A fresh BIND has already decided every entry's binding, including the ones it
        // deliberately cleared because the book no longer contains that text. Carrying the
        // old value back in would resurrect a referenceId that no longer exists — and since
        // ClaimsJoiner keys on bound_reference_id, a dangling one does not error, it just
        // never joins: the entry silently disappears from the workbench instead of showing
        // up as "re-label me". That is how a reconverted deloitte came out claiming 129 of
        // 129 bound while 11 pointed at rows that had been deleted. The carry-over exists to
        // protect bindings when a GENERATOR rewrites the entries (corrupt / skeleton), and
        // only a bind sets `binding.bound_at` — which this method already tests below.
        $freshlyBound = !empty($groundTruth['binding']['bound_at']);

        if (is_file($path)) {
            $existing = json_decode((string) file_get_contents($path), true);
            $previousBindings = [];
            $previousHuman = [];
            foreach ($existing['entries'] ?? [] as $entry) {
                $key = ($entry['bib_text_hash'] ?? '') . '|' . ($entry['claim_snippet'] ?? '');
                if (!empty($entry['bound_reference_id'])) {
                    $previousBindings[$key] = $entry['bound_reference_id'];
                }
                foreach ($humanFields as $field) {
                    if (($entry[$field] ?? null) !== null && $entry[$field] !== '') {
                        $previousHuman[$key][$field] = $entry[$field];
                    }
                }
            }
            $carried = 0;
            foreach ($groundTruth['entries'] as &$entry) {
                $key = ($entry['bib_text_hash'] ?? '') . '|' . ($entry['claim_snippet'] ?? '');
                if (isset($previousHuman[$key])) {
                    foreach ($previousHuman[$key] as $field => $value) {
                        if (($entry[$field] ?? null) === null || $entry[$field] === '') {
                            $entry[$field] = $value;
                        }
                    }
                }
                if (!empty($entry['bound_reference_id']) || $freshlyBound) {
                    continue;
                }
                if (isset($previousBindings[$key])) {
                    $entry['bound_reference_id'] = $previousBindings[$key];
                    $carried++;
                }
            }
            unset($entry);
            if ($carried > 0 && empty($groundTruth['binding']['bound_at'])) {
                $groundTruth['binding'] = $existing['binding'] ?? $groundTruth['binding'];
                $groundTruth['binding']['carried_over'] = $carried;
            }
        }

        @mkdir(dirname($path), 0775, true);
        file_put_contents(
            $path,
            json_encode($groundTruth, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
        );
    }

    public function resultsDir(): string
    {
        return base_path(config('study.root', 'study') . "/results/{$this->corpus}");
    }

    public function lockPath(): string
    {
        return "{$this->dir}/corpus.lock.json";
    }
}
