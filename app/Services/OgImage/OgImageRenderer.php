<?php

namespace App\Services\OgImage;

use Imagick;
use ImagickDraw;
use ImagickPixel;

/**
 * Renders a per-book Open Graph card (1200x630) — the Hyperlit wordmark with a
 * formatted citation underneath, on an opaque dark background so it renders
 * identically on WhatsApp / LinkedIn / iMessage / Facebook (no transparency for
 * platforms to flatten differently). The citation mirrors the front-end
 * formatBibtexToCitation() format (book = italic title; article = quoted title).
 */
class OgImageRenderer
{
    private const W = 1200;
    private const H = 630;
    private const BG = '#111827';
    private const TEXT = '#cbd5e1';

    /** Citation-relevant fields, in a stable order, used for both hashing + rendering. */
    private const FIELDS = ['author', 'title', 'year', 'journal', 'publisher', 'volume', 'issue', 'pages', 'booktitle', 'editor'];

    /** Cache key that changes whenever any citation field (or the renderer) changes. */
    public static function hash(object $library): string
    {
        $parts = [];
        foreach (self::FIELDS as $f) {
            $parts[$f] = $library->$f ?? null;
        }
        // bump 'v1' to force a global re-render after a design change
        return substr(md5('v1|' . json_encode($parts)), 0, 10);
    }

    public static function isAvailable(): bool
    {
        return extension_loaded('imagick');
    }

    /** Columns to SELECT from `library` for hashing + rendering. */
    public static function renderFields(): array
    {
        return self::FIELDS;
    }

    private function fontPath(string $file): string
    {
        return base_path('resources/fonts/og/' . $file);
    }

    private function decode(?string $s): string
    {
        return trim(html_entity_decode($s ?? '', ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    /**
     * Build the citation as an array of paragraphs (each rendered on its own
     * line(s)), so the authors and the title are easy to parse at a glance:
     *   paragraph 1 -> authors
     *   paragraph 2 -> title (quoted if article, italic if book) + the rest
     * Each paragraph is a list of [text, italic] segments.
     */
    private function citationParagraphs(object $d): array
    {
        $author    = $this->decode($d->author ?? '') ?: 'Unknown Author';
        $title     = $this->decode($d->title ?? '') ?: 'Untitled';
        $journal   = $this->decode($d->journal ?? '');
        $publisher = $this->decode($d->publisher ?? '');
        $year      = $this->decode($d->year ?? '');
        $volume    = $this->decode($d->volume ?? '');
        $issue     = $this->decode($d->issue ?? '');
        $isArticle = $journal !== '';

        $titleSeg = $isArticle ? ['“' . $title . '”', false] : [$title, true];

        $tail = '';
        if ($isArticle) {
            if ($journal) $tail .= ', ' . $journal;
            if ($volume)  { $tail .= ', ' . $volume; if ($issue) $tail .= '(' . $issue . ')'; }
            if ($year)    $tail .= ' (' . $year . ')';
        } else {
            if ($publisher) { $tail .= ' (' . $publisher; if ($year) $tail .= ', ' . $year; $tail .= ')'; }
            elseif ($year)  { $tail .= ' (' . $year . ')'; }
        }
        $tail .= '.';

        return [
            [ [$author, false] ],          // authors on their own line
            [ $titleSeg, [$tail, false] ], // title + everything else
        ];
    }

    /** Returns PNG bytes for the given library row. */
    public function render(object $library): string
    {
        $fontReg  = $this->fontPath('Inter-Regular.ttf');
        $fontItal = $this->fontPath('Inter-Italic.ttf');

        $img = new Imagick();
        $img->newImage(self::W, self::H, new ImagickPixel(self::BG));
        $img->setImageFormat('png');

        $leftMargin = 48;

        // --- wordmark (composited, scaled, top-left) ---
        $logo = new Imagick(public_path('images/og-default.png'));
        $lw = $logo->getImageWidth();
        $lh = $logo->getImageHeight();
        $targetW = 740;
        $scale = $targetW / $lw;
        $logoH = (int) round($lh * $scale);
        $logo->resizeImage($targetW, $logoH, Imagick::FILTER_LANCZOS, 1);
        $logoY = 16;
        $img->compositeImage($logo, Imagick::COMPOSITE_OVER, $leftMargin, $logoY);

        // --- citation: authors paragraph, then title (+ rest) paragraph ---
        $paragraphs = $this->citationParagraphs($library);
        $citationX = 96;   // citation indented further than the logo
        $citationRight = 120; // right-side indent so lines wrap before the edge
        $fontSize = 38;
        $maxW = self::W - $citationX - $citationRight;
        $lineH = 54;
        $paraGap = 0;      // author->title gap == normal line gap

        $measure = function (string $font, string $text) use ($img, $fontSize): float {
            $d = new ImagickDraw();
            $d->setFont($font);
            $d->setFontSize($fontSize);
            $m = $img->queryFontMetrics($d, $text);
            return $m['textWidth'];
        };

        $titleIndent = 32; // title paragraph indented further than the authors line

        // greedy word-wrap for one paragraph's segments -> array of lines
        $wrap = function (array $segments, float $maxW) use ($measure, $fontReg, $fontItal): array {
            $words = [];
            foreach ($segments as [$txt, $ital]) {
                foreach (preg_split('/(\s+)/u', $txt, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) as $tok) {
                    $words[] = [$tok, $ital];
                }
            }
            $lines = [];
            $cur = [];
            $curW = 0;
            foreach ($words as [$tok, $ital]) {
                $font = $ital ? $fontItal : $fontReg;
                $w = $measure($font, $tok === ' ' ? ' ' : $tok);
                if ($curW + $w > $maxW && $cur) {
                    $lines[] = $cur;
                    $cur = [];
                    $curW = 0;
                    if (trim($tok) === '') continue;
                }
                $cur[] = [$tok, $ital, $w];
                $curW += $w;
            }
            if ($cur) $lines[] = $cur;
            return $lines;
        };

        // draw paragraphs left-aligned, starting just below the wordmark
        $y = $logoY + $logoH + 32 + $fontSize;
        foreach ($paragraphs as $pi => $segments) {
            $xBase = $citationX + ($pi > 0 ? $titleIndent : 0);
            $paraMaxW = self::W - $xBase - $citationRight;
            foreach ($wrap($segments, $paraMaxW) as $line) {
                $x = $xBase;
                foreach ($line as [$tok, $ital, $w]) {
                    $d = new ImagickDraw();
                    $d->setFont($ital ? $fontItal : $fontReg);
                    $d->setFontSize($fontSize);
                    $d->setFillColor(new ImagickPixel(self::TEXT));
                    $img->annotateImage($d, $x, $y, 0, $tok);
                    $x += $w;
                }
                $y += $lineH;
            }
            $y += $paraGap;
        }

        // Strip alpha entirely -> opaque RGB, so no platform can flatten it oddly.
        $img->setImageBackgroundColor(new ImagickPixel(self::BG));
        $img = $img->mergeImageLayers(Imagick::LAYERMETHOD_FLATTEN);
        $img->setImageAlphaChannel(Imagick::ALPHACHANNEL_OFF);
        $img->setImageType(Imagick::IMGTYPE_TRUECOLOR);
        $img->setImageFormat('png');

        $blob = $img->getImageBlob();
        $img->clear();
        $logo->clear();
        return $blob;
    }
}
