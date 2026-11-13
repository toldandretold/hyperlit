<?php

namespace App\Services\SourceImport\Identifier;

/**
 * Turns whatever a user pasted into a typed Identifier.
 *
 * Accepts: arXiv URLs (arxiv.org/abs, arxiv.org/pdf, ar5iv variants), bare arXiv IDs
 * (new-style "2302.08927", old-style "cs/0301001"), DOI URLs (doi.org/..., dx.doi.org/...),
 * bare DOIs ("doi:10.xxxx/..." or "10.xxxx/..."), OpenAlex work ids ("W2126853606",
 * openalex.org/W…), and Project Gutenberg book URLs
 * (gutenberg.org/ebooks/<id>, plus /cache/epub/<id>/ and /files/<id>/ file links).
 *
 * Pure parsing — no I/O. arXiv is checked before DOI because arXiv DOIs would also match
 * the DOI regex and arXiv has a more specific shape. Gutenberg requires its host, so it
 * can't collide with either.
 */
class IdentifierNormalizer
{
    public function parse(string $input): ?Identifier
    {
        $trimmed = trim($input);
        if ($trimmed === '') {
            return null;
        }

        if ($arxiv = $this->tryArxiv($trimmed)) {
            return $arxiv;
        }

        if ($gutenberg = $this->tryGutenberg($trimmed)) {
            return $gutenberg;
        }

        // Before DOI: an openalex.org URL can never contain a DOI, and a bare "W123…"
        // can never be one, so the order only matters for clarity.
        if ($openAlex = $this->tryOpenAlex($trimmed)) {
            return $openAlex;
        }

        return $this->tryDoi($trimmed);
    }

    private function tryOpenAlex(string $input): ?OpenAlexId
    {
        // https://openalex.org/W2126853606, https://api.openalex.org/works/W2126853606
        if (preg_match('#openalex\.org/(?:works/)?(W\d{3,})\b#i', $input, $m)) {
            return new OpenAlexId($m[1]);
        }

        // Bare id, optionally "openalex:"-prefixed. Anchored: a "W123" inside prose is not an id.
        if (preg_match('#^(?:openalex:\s*)?(W\d{3,})$#i', $input, $m)) {
            return new OpenAlexId($m[1]);
        }

        return null;
    }

    private function tryGutenberg(string $input): ?GutenbergId
    {
        // Canonical book page (optionally with a format suffix the download
        // links carry, e.g. /ebooks/79922.epub3.images, or a query string).
        if (preg_match('#(?:www\.)?gutenberg\.org/ebooks/(\d+)#i', $input, $m)) {
            return new GutenbergId($m[1]);
        }

        // Direct file links: /cache/epub/<id>/pg<id>.epub, /files/<id>/<id>-0.txt
        if (preg_match('#(?:www\.)?gutenberg\.org/(?:cache/epub|files)/(\d+)/#i', $input, $m)) {
            return new GutenbergId($m[1]);
        }

        return null;
    }

    private function tryArxiv(string $input): ?ArxivId
    {
        // arXiv DOI prefix → unwrap to bare ID
        if (preg_match('#10\.48550/arXiv\.([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(v\d+)?#i', $input, $m)) {
            return new ArxivId($m[1]);
        }

        // URLs: arxiv.org/abs/<id>, arxiv.org/pdf/<id>, ar5iv variants
        if (preg_match('#arxiv\.(?:org|labs\.arxiv\.org)/(?:abs|pdf|html)/([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(v\d+)?#i', $input, $m)) {
            return new ArxivId($m[1]);
        }
        if (preg_match('#ar5iv\.(?:labs\.arxiv\.org|org)/(?:abs|html)/([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(v\d+)?#i', $input, $m)) {
            return new ArxivId($m[1]);
        }

        // Explicit prefix: arxiv:<id>
        if (preg_match('#^arxiv:\s*([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(v\d+)?$#i', $input, $m)) {
            return new ArxivId($m[1]);
        }

        // Bare ID: new-style 2302.08927 or old-style cs/0301001 (must be standalone)
        if (preg_match('#^([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(v\d+)?$#i', $input, $m)) {
            return new ArxivId($m[1]);
        }

        return null;
    }

    private function tryDoi(string $input): ?Doi
    {
        // URL forms: https://doi.org/<doi>, https://dx.doi.org/<doi>
        if (preg_match('#doi\.org/(10\.\d{4,9}/[^\s<>"]+)#i', $input, $m)) {
            return new Doi($this->trimDoiTail($m[1]));
        }

        // doi: prefix or bare DOI
        if (preg_match('#(?:^doi:\s*)?(10\.\d{4,9}/[^\s<>"]+)#i', $input, $m)) {
            $doi = $m[1];
            // A DOI lifted out of a PUBLISHER url ("…/doi/full/10.1080/x?src=recsys",
            // "…/doi/10.1111/x/abstract") drags the page's own tail along with it, and the
            // result is a DOI OpenAlex has never heard of. Only for URLs: a bare DOI may
            // legitimately contain "?" or "#" (old SICI-style Wiley DOIs do).
            if (preg_match('#^https?://#i', $input)) {
                $doi = $this->stripPublisherUrlTail($doi);
            }

            return new Doi($this->trimDoiTail($doi));
        }

        return null;
    }

    /** Path segments publishers append AFTER the DOI in their article URLs. */
    private const PUBLISHER_URL_SUFFIX_RE = '#/(?:full|fulltext|abstract|pdf|epdf|pdfdirect|html|references|figures|metrics)/?$#i';

    private function stripPublisherUrlTail(string $doi): string
    {
        $doi = preg_replace('/[?#].*$/', '', $doi) ?? $doi;

        return preg_replace(self::PUBLISHER_URL_SUFFIX_RE, '', $doi) ?? $doi;
    }

    /**
     * DOIs grabbed from prose often have trailing punctuation that doesn't belong.
     * The DOI spec allows almost any character, but in practice "." "," ";" ")" at
     * the very end are punctuation from the surrounding sentence, not the DOI itself.
     */
    private function trimDoiTail(string $doi): string
    {
        return rtrim($doi, '.,;)');
    }
}
