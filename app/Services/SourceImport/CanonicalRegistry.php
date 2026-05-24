<?php

namespace App\Services\SourceImport;

use App\Models\CanonicalSource;
use App\Models\PgLibrary;
use App\Services\SourceImport\Identifier\ArxivId;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Identifier\Identifier;

/**
 * Lookup-by-identifier on canonical_source. Used pre-import for dedup ("does the
 * library already have this work?") and anywhere else identifier→canonical resolution
 * is needed — citation linking, share-link routing, future bulk importers.
 *
 * Does not know about the import flow. Returns ?CanonicalSource and stops.
 */
class CanonicalRegistry
{
    /**
     * @return CanonicalSource|null Existing canonical for this identifier, if any.
     */
    public function findByIdentifier(Identifier $id): ?CanonicalSource
    {
        $doiCandidates = $this->doiCandidates($id);
        foreach ($doiCandidates as $doi) {
            if ($hit = CanonicalSource::whereRaw('LOWER(doi) = ?', [strtolower($doi)])->first()) {
                return $hit;
            }
        }
        return null;
    }

    /**
     * Find all library rows that look like versions of the work referenced by $id.
     *
     * Two paths, in order:
     *   1. Canonical exists → return its linked versions (preferred).
     *   2. Canonical doesn't exist yet → fall back to library.doi / library.openalex_id
     *      matches. This catches imports that landed before this codebase auto-created
     *      canonical rows, and any future asymmetry where the matcher hasn't run.
     *
     * The DOI compare is case-insensitive to handle arXiv DOIs that may appear as
     * "10.48550/arxiv.X" or "10.48550/arXiv.X" depending on the source.
     *
     * @return PgLibrary[]
     */
    public function findVersionsByIdentifier(Identifier $id): array
    {
        if ($canonical = $this->findByIdentifier($id)) {
            return $canonical->versions()
                ->orderBy('timestamp', 'desc')
                ->get()
                ->all();
        }

        $query = PgLibrary::query();
        $applied = false;
        foreach ($this->doiCandidates($id) as $doi) {
            $query->orWhereRaw('LOWER(doi) = ?', [strtolower($doi)]);
            $applied = true;
        }
        if (!$applied) {
            return [];
        }
        return $query->orderBy('timestamp', 'desc')->get()->all();
    }

    /**
     * Identifier → list of DOI strings to try (handles arXiv's mixed-case DOI form).
     *
     * @return string[]
     */
    private function doiCandidates(Identifier $id): array
    {
        if ($id instanceof Doi) {
            return [$id->value()];
        }
        if ($id instanceof ArxivId) {
            // arXiv's canonical DOI uses "arXiv" (mixed case) but OpenAlex normalises
            // to lowercase. Cover both so the registry doesn't miss a match on either.
            $value = $id->value();
            return [
                '10.48550/arXiv.' . $value,
                '10.48550/arxiv.' . $value,
            ];
        }
        return [];
    }
}
