<?php

namespace App\Services\OgImage;

use Imagick;
use ImagickDraw;
use ImagickPixel;

/**
 * Renders a per-book Open Graph card (1200x630) — a title-page style layout:
 * the Hyperlit wordmark top-left, then the book title (heading font), authors
 * and venue below it. Drawn on an opaque dark background that matches the app's
 * dark theme (no transparency for platforms to flatten differently, so it looks
 * identical on WhatsApp / LinkedIn / iMessage / Facebook).
 *
 * Fonts + colours mirror the app theme (resources/css/theme/variables.css):
 * Inter SemiBold (heading) + Inter Regular (body); background #221F20.
 */
class OgImageRenderer
{
    private const W = 1200;
    private const H = 630;

    // Theme (variables.css): --hyperlit-black bg, --hyperlit-white text + muted tiers.
    private const BG    = '#221F20';
    private const TITLE = '#CBCCCC';
    private const BODY  = '#B2B3B3';
    private const FAINT = '#8F9090';

    private const LEFT  = 80;   // text + logo left margin (logo squares align to text)

    /** Citation-relevant fields, in a stable order, used for both hashing + rendering. */
    private const FIELDS = ['author', 'title', 'year', 'journal', 'publisher', 'volume', 'issue', 'pages', 'booktitle', 'editor'];

    /** Cache key that changes whenever any citation field (or the renderer) changes. */
    public static function hash(object $library): string
    {
        $parts = [];
        foreach (self::FIELDS as $f) {
            $parts[$f] = $library->$f ?? null;
        }
        // bump 'v2' to force a global re-render after a design change
        return substr(md5('v2|' . json_encode($parts)), 0, 10);
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

    /** Authors line, venue line — from the library row. */
    private function citationLines(object $d): array
    {
        $title     = $this->decode($d->title ?? '') ?: 'Untitled';
        $author    = $this->decode($d->author ?? '');
        $journal   = $this->decode($d->journal ?? '');
        $publisher = $this->decode($d->publisher ?? '');
        $year      = $this->decode($d->year ?? '');
        $volume    = $this->decode($d->volume ?? '');
        $issue     = $this->decode($d->issue ?? '');

        // authors: normalise "A; B; C" -> "A, B, C"
        $authors = $author !== '' ? str_replace('; ', ', ', $author) : '';

        // venue: journal (+ vol(issue)) for articles, else publisher; then year
        $bits = [];
        if ($journal !== '') {
            $v = $journal;
            if ($volume !== '') { $v .= ' ' . $volume; if ($issue !== '') $v .= '(' . $issue . ')'; }
            $bits[] = $v;
        } elseif ($publisher !== '') {
            $bits[] = $publisher;
        }
        if ($year !== '') $bits[] = $year;
        $venue = implode(', ', $bits);

        return [$title, $authors, $venue];
    }

    /** Returns PNG bytes for the given library row. */
    public function render(object $library): string
    {
        $fontTitle = $this->fontPath('Inter-SemiBold.ttf');
        $fontBody  = $this->fontPath('Inter-Regular.ttf');

        $img = new Imagick();
        $img->newImage(self::W, self::H, new ImagickPixel(self::BG));
        $img->setImageFormat('png');

        // --- wordmark top-left; trim its transparent padding so the coloured
        //     squares are the true left edge, aligned to the text margin ---
        $logo = new Imagick(public_path('images/og-default.png'));
        $logo->trimImage(0);
        $logo->setImagePage(0, 0, 0, 0);
        $targetW = 600;
        $logoH = (int) round($logo->getImageHeight() * ($targetW / $logo->getImageWidth()));
        $logo->resizeImage($targetW, $logoH, Imagick::FILTER_LANCZOS, 1);
        $logoY = 104;
        $img->compositeImage($logo, Imagick::COMPOSITE_OVER, self::LEFT, $logoY);

        [$title, $authors, $venue] = $this->citationLines($library);
        $maxW = self::W - self::LEFT - 120;

        $measure = function (string $font, float $size, string $text) use ($img): float {
            $d = new ImagickDraw();
            $d->setFont($font);
            $d->setFontSize($size);
            return $img->queryFontMetrics($d, $text)['textWidth'];
        };

        // draw a left-aligned, word-wrapped block; returns the y after the block
        $draw = function (string $font, float $size, string $color, string $text, float $y, float $lineH)
                use ($img, $measure, $maxW): float {
            if (trim($text) === '') return $y;
            $words = preg_split('/\s+/u', trim($text));
            $lines = [];
            $cur = '';
            foreach ($words as $wd) {
                $try = $cur === '' ? $wd : "$cur $wd";
                if ($measure($font, $size, $try) > $maxW && $cur !== '') {
                    $lines[] = $cur;
                    $cur = $wd;
                } else {
                    $cur = $try;
                }
            }
            if ($cur !== '') $lines[] = $cur;

            foreach ($lines as $ln) {
                $d = new ImagickDraw();
                $d->setFont($font);
                $d->setFontSize($size);
                $d->setFillColor(new ImagickPixel($color));
                $img->annotateImage($d, self::LEFT, $y, 0, $ln);
                $y += $lineH;
            }
            return $y;
        };

        $y = $logoY + $logoH + 86;
        $y = $draw($fontTitle, 46, self::TITLE, $title,   $y, 58);
        $y += 14;
        $y = $draw($fontBody,  28, self::BODY,  $authors, $y, 40);
        $y += 6;
        $y = $draw($fontBody,  24, self::FAINT, $venue,   $y, 34);

        // opaque RGB out — flattening onto the solid background removes all
        // transparency (no setImageAlphaChannel: that constant differs across
        // ImageMagick versions); TRUECOLOR forces an RGB (no-alpha) PNG.
        $img->setImageBackgroundColor(new ImagickPixel(self::BG));
        $img = $img->mergeImageLayers(Imagick::LAYERMETHOD_FLATTEN);
        $img->setImageType(Imagick::IMGTYPE_TRUECOLOR);
        $img->setImageFormat('png');

        $blob = $img->getImageBlob();
        $img->clear();
        $logo->clear();
        return $blob;
    }
}
