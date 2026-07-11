<?php

namespace App\Services\OpenAlex;

/**
 * Pure text-parsing helpers that pull identifiers and titles out of raw
 * citation strings (bibliography entries, BibTeX, scraped HTML). No HTTP,
 * no DB — safe to reuse against any source, not just OpenAlex.
 */
class CitationTextExtractor
{
    /**
     * Extract a DOI from HTML content or plain text.
     * Looks for <a href="...doi.org/..."> links first, then plain text DOI patterns.
     */
    public function extractDoi(string $html): ?string
    {
        // 1. Look for DOI links: <a href="https://doi.org/10.xxxx/...">
        if (preg_match('#href=["\']https?://(?:dx\.)?doi\.org/(10\.\d{4,9}/[^\s"\'<>]+)["\']#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 2. Plain text DOI pattern: doi:10.xxxx/... or https://doi.org/10.xxxx/...
        if (preg_match('#(?:doi:\s*|https?://(?:dx\.)?doi\.org/)(10\.\d{4,9}/[^\s<>]+)#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 3. Bare DOI: 10.xxxx/... (must start at word boundary)
        if (preg_match('#\b(10\.\d{4,9}/[^\s<>"]+)#', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        return null;
    }

    /**
     * Extract an ISBN-13 or ISBN-10 from text (typically a BibTeX entry or URL). Accepts the common
     * hyphen/space groupings and an "isbn:"/"ISBN " prefix; strips separators before validating the
     * digit count. Returns the normalised digits-only ISBN, or null. ISBN-13 is preferred over -10.
     */
    public function extractIsbn(string $text): ?string
    {
        // ISBN-13 first (13 digits, optionally grouped by - or space).
        if (preg_match('/\b(?:isbn[:\s]*)?(97[89][\d\-\s]{10,16}\d)\b/i', $text, $m)) {
            $digits = preg_replace('/[^\d]/', '', $m[1]);
            if (strlen($digits) === 13) return $digits;
        }
        // ISBN-10 (10 chars, final may be X).
        if (preg_match('/\b(?:isbn[:\s]*)?(\d[\d\-\s]{8,12}[\dXx])\b/i', $text, $m)) {
            $compact = preg_replace('/[^\dXx]/', '', $m[1]);
            if (strlen($compact) === 10) return strtoupper($compact);
        }
        return null;
    }

    /**
     * Extract the title from a raw citation string (may contain HTML).
     * Bibtex formatting wraps book titles in <i> and article titles in quotes.
     * Also handles EPUB text-style spans like <span class="t13">.
     */
    public function extractTitle(string $raw): string
    {
        $plain = strip_tags($raw);

        // 1. Quoted title: "Title" or curly quotes — article/chapter titles are typically quoted
        if (preg_match('/[\x{201C}""]([^\x{201C}\x{201D}""]+)[\x{201D}""]/u', $plain, $m)) {
            $quoted = trim($m[1], " \t\n\r.");
            if (strlen($quoted) >= 10) {
                return $quoted;
            }
        }

        // Italic tag pattern: <i>, <em>, or <span class="tNN"> (EPUB text-style classes)
        $italicPattern = '#<(?:i|em|span\s+class="t\d+")>#i';

        // 2. HTML italic title: find the first italic marker and use year-anchor logic
        if (preg_match($italicPattern, $raw)) {
            // Extract italic text (handle all three tag types)
            $italicText = null;
            if (preg_match('#<(?:i|em)>(.*?)</(?:i|em)>#is', $raw, $m)) {
                $italicText = trim(strip_tags($m[1]));
            } elseif (preg_match('#<span\s+class="t\d+">(.*?)</span>#is', $raw, $m)) {
                $italicText = trim(strip_tags($m[1]));
            }

            if ($italicText && strlen($italicText) >= 5) {
                // Find year (19xx or 20xx) position in plain text
                $yearPos = null;
                if (preg_match('/\b(19|20)\d{2}\b/', $plain, $ym, PREG_OFFSET_CAPTURE)) {
                    $yearPos = $ym[0][1] + strlen($ym[0][0]);
                }

                // Find italic marker position in plain text by locating the italic text
                $italicPos = $italicText ? mb_strpos($plain, $italicText) : false;

                // If there's text between year and italic → that's an article title
                if ($yearPos !== null && $italicPos !== false && $italicPos > $yearPos) {
                    $between = trim(substr($plain, $yearPos, $italicPos - $yearPos));
                    // Strip leading punctuation/whitespace
                    $between = preg_replace('/^[\s.,;:)\]]+/', '', $between);
                    // Strip trailing punctuation
                    $between = preg_replace('/[\s.,;:]+$/', '', $between);
                    if (strlen($between) >= 10) {
                        return $between;
                    }
                }

                // No text before italic, or text too short → italic text is the title (book)
                return $italicText;
            }
        }

        // 3. Year-anchor fallback: find year, take text after it up to the first sentence boundary
        if (preg_match('/\b(?:19|20)\d{2}[a-z]?\b[.)]*\s*(.+)/u', $plain, $m)) {
            $afterYear = trim($m[1]);
            // Strip leading punctuation
            $afterYear = preg_replace('/^[\s.,;:)\]]+/', '', $afterYear);
            if (preg_match('/^(.+?)\.\s/', $afterYear, $sm)) {
                $title = trim($sm[1]);
                if (strlen($title) >= 10) {
                    return $title;
                }
            }
            // If no sentence boundary, take up to 150 chars
            if (strlen($afterYear) >= 10) {
                return trim(substr($afterYear, 0, 150));
            }
        }

        // 4. Last resort: strip author pattern and year, truncate at first sentence boundary
        $cleaned = preg_replace('/^[A-Z][a-z]+,\s*[A-Z][a-z.]+(?:\s+and\s+[A-Z][a-z]+,\s*[A-Z][a-z.]+)*\.?\s*/', '', $plain);
        $cleaned = preg_replace('/\(?\d{4}\)?[.:]?\s*\d*[-\x{2013}]?\d*\.?/u', '', $cleaned);
        $cleaned = trim($cleaned);

        if (preg_match('/^(.+?)\.\s/', $cleaned, $m)) {
            $title = trim($m[1]);
            if (strlen($title) >= 10) {
                return $title;
            }
        }

        return trim(substr($cleaned, 0, 150));
    }
}
