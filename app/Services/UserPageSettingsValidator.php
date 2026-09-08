<?php

namespace App\Services;

use App\Services\Security\NodeHtmlSanitizer;
use Illuminate\Support\Facades\DB;

/**
 * Validates the /u/{username} page_settings payload before it is stored on
 * the user-home library row and served to EVERY visitor of that page.
 *
 * This is a security boundary, not a preference filter: css_vars values are
 * interpolated into a <style> block in user.blade.php, so both the variable
 * NAME and its VALUE are allowlisted here. Do not relax this to name-only
 * validation — that is the vibe-CSS seam's known gap (an unvalidated value
 * containing `}` breaks out of its rule block and injects arbitrary CSS at
 * visitors).
 *
 * Font families are TOKENS mapped server-side to full stacks (fontStack()),
 * never free-text strings from the client.
 */
class UserPageSettingsValidator
{
    /** Curated variable set: name => value grammar. */
    private const COLOR_VARS = [
        '--up-bg',
        '--up-card-bg',
        '--up-text',
        '--up-accent',
        '--up-title-color',
        '--up-pill-bg',
        '--up-pill-active-bg',
        '--up-pill-text',
    ];

    private const FONT_VARS = ['--up-title-font', '--up-body-font'];

    private const SIZE_VARS = ['--up-title-size'];

    /**
     * Deliberately QUOTE-FREE stacks (multi-word family names are valid
     * unquoted CSS): the blade prints values through {{ }} escaping, and a
     * quote would arrive as &#039; inside the <style> block.
     */
    private const FONT_STACKS = [
        'system'  => 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        'sans'    => 'Helvetica Neue, Helvetica, Arial, sans-serif',
        'serif'   => 'Georgia, Times New Roman, Times, serif',
        'georgia' => 'Georgia, serif',
        'mono'    => 'SF Mono, SFMono-Regular, Consolas, Menlo, monospace',
    ];

    private const COLOR_RE = '/^#[0-9a-fA-F]{3,8}$/';
    private const SIZE_RE  = '/^(\d{1,2}(\.\d{1,2})?)(px|rem|em)$/';
    private const IMAGE_RE = '/^[A-Za-z0-9._-]{1,255}$/';

    /**
     * Background-art registry: each name is a renderable background design.
     * 'hills' = the default lava-lamp art; 'none' = plain theme background
     * (the blade stamps `bg-art-{name}` on #app-container; CSS/JS key off it).
     * New designs = add the name here + its render (CSS or a lava-style
     * component) — the settings/panel plumbing picks it up unchanged.
     */
    public const BACKGROUND_ARTS = ['hills', 'none'];

    private const ABOUT_MAX_RAW = 20000;
    private const ABOUT_MAX_CLEAN = 10000;
    private const MAX_CSS_VARS = 20;

    /**
     * Validate + normalize an incoming settings payload.
     *
     * @param  array   $input     raw request payload
     * @param  string  $book      the user-home book id (sanitized username) —
     *                            used to verify image filenames exist in book_images
     * @param  ?string $ownerName the ACTUAL username (spaces intact) — shelf
     *                            ownership checks for pill_shelves
     * @return array{ok: bool, errors: array<string,string>, settings: array}
     *         settings holds only the validated keys, with about_html already
     *         SANITIZED — store and echo back exactly this.
     */
    private ?string $ownerName = null;

    public function validate(array $input, string $book, ?string $ownerName = null): array
    {
        $this->ownerName = $ownerName;
        $errors = [];
        $settings = [];

        foreach (['logo_image', 'background_image'] as $key) {
            if (!array_key_exists($key, $input)) {
                continue;
            }
            $value = $input[$key];
            if ($value === null || $value === '') {
                $settings[$key] = null;
                continue;
            }
            if (!is_string($value) || !preg_match(self::IMAGE_RE, $value)) {
                $errors[$key] = 'Invalid image filename.';
                continue;
            }
            $exists = DB::connection('pgsql_admin')->table('book_images')
                ->where('book', $book)
                ->where('filename', $value)
                ->exists();
            if (!$exists) {
                $errors[$key] = 'Image not found for this page.';
                continue;
            }
            $settings[$key] = $value;
        }

        if (array_key_exists('css_vars', $input)) {
            $raw = $input['css_vars'];
            if ($raw === null) {
                $settings['css_vars'] = null;
            } elseif (!is_array($raw)) {
                $errors['css_vars'] = 'css_vars must be an object.';
            } elseif (count($raw) > self::MAX_CSS_VARS) {
                $errors['css_vars'] = 'Too many variables.';
            } else {
                $clean = [];
                foreach ($raw as $name => $value) {
                    if (!is_string($name) || !is_string($value)) {
                        $errors['css_vars'] = 'Variable names and values must be strings.';
                        break;
                    }
                    $verdict = $this->validateVar($name, $value);
                    if ($verdict !== true) {
                        $errors['css_vars'] = $verdict;
                        break;
                    }
                    $clean[$name] = $value;
                }
                if (!isset($errors['css_vars'])) {
                    $settings['css_vars'] = $clean ?: null;
                }
            }
        }

        // background_art: named design from the registry; null = default hills.
        if (array_key_exists('background_art', $input)) {
            $raw = $input['background_art'];
            if ($raw === null || $raw === '' || $raw === 'hills') {
                $settings['background_art'] = null; // default — store nothing
            } elseif (is_string($raw) && in_array($raw, self::BACKGROUND_ARTS, true)) {
                $settings['background_art'] = $raw;
            } else {
                $errors['background_art'] = 'Unknown background art.';
            }
        }

        // show_map: render the library's hypercite-network SVG under the about
        // section (JournalHyperciteMap::svgForBooks, public books only).
        if (array_key_exists('show_map', $input)) {
            $raw = $input['show_map'];
            if ($raw === null || $raw === false) {
                $settings['show_map'] = null;
            } elseif ($raw === true) {
                $settings['show_map'] = true;
            } else {
                $errors['show_map'] = 'show_map must be a boolean.';
            }
        }

        // pill_shelves: which of the owner's PUBLIC shelves render as visitor
        // pills. Checked = shown: null clears the curation (default — all
        // shelves show), an EMPTY ARRAY is a real state (owner unticked
        // everything = no pills). Ownership-checked.
        if (array_key_exists('pill_shelves', $input)) {
            $raw = $input['pill_shelves'];
            if ($raw === null) {
                $settings['pill_shelves'] = null;
            } elseif ($raw === []) {
                $settings['pill_shelves'] = [];
            } elseif (!is_array($raw) || count($raw) > 24) {
                $errors['pill_shelves'] = 'Invalid shelf selection.';
            } else {
                $ids = array_values(array_unique(array_filter($raw, fn ($v) => is_string($v) && preg_match('/^[0-9a-f-]{36}$/i', $v))));
                if (count($ids) !== count($raw)) {
                    $errors['pill_shelves'] = 'Invalid shelf selection.';
                } else {
                    $owned = DB::connection('pgsql_admin')->table('shelves')
                        ->whereIn('id', $ids)
                        ->where('creator', $this->ownerName ?? '')
                        ->count();
                    if ($owned !== count($ids)) {
                        $errors['pill_shelves'] = 'Unknown shelf in selection.';
                    } else {
                        $settings['pill_shelves'] = $ids;
                    }
                }
            }
        }

        if (array_key_exists('about_html', $input)) {
            $raw = $input['about_html'];
            if ($raw === null || $raw === '') {
                $settings['about_html'] = null;
            } elseif (!is_string($raw) || mb_strlen($raw) > self::ABOUT_MAX_RAW) {
                $errors['about_html'] = 'About text is too long.';
            } else {
                $clean = NodeHtmlSanitizer::clean($raw) ?? '';
                if (mb_strlen($clean) > self::ABOUT_MAX_CLEAN) {
                    $errors['about_html'] = 'About text is too long.';
                } else {
                    $settings['about_html'] = $clean === '' ? null : $clean;
                }
            }
        }

        return ['ok' => empty($errors), 'errors' => $errors, 'settings' => $settings];
    }

    /** @return true|string true when valid, else an error message */
    private function validateVar(string $name, string $value): bool|string
    {
        // Belt-and-braces before any grammar: nothing that could terminate a
        // declaration, rule block, or open a resource fetch survives.
        if (preg_match('/[;{}()\\\\\/"\']|url|@/i', $value)) {
            return "Disallowed characters in {$name}.";
        }

        if (in_array($name, self::COLOR_VARS, true)) {
            return preg_match(self::COLOR_RE, $value) ? true : "{$name} must be a hex color.";
        }

        if (in_array($name, self::FONT_VARS, true)) {
            return array_key_exists($value, self::FONT_STACKS) ? true : "{$name} must be a known font token.";
        }

        if (in_array($name, self::SIZE_VARS, true)) {
            if (!preg_match(self::SIZE_RE, $value, $m)) {
                return "{$name} must be a simple length.";
            }
            $n = (float) $m[1];
            $ok = match ($m[3]) {
                'px' => $n >= 10 && $n <= 96,
                default => $n >= 0.8 && $n <= 6,
            };
            return $ok ? true : "{$name} is out of range.";
        }

        return "Unknown variable {$name}.";
    }

    /**
     * Map a stored font token to its full stack for render-time emission.
     * Returns null for anything unrecognized (defensive: stored values are
     * already validated, but old rows must never emit raw strings).
     */
    public static function fontStack(?string $token): ?string
    {
        return $token === null ? null : (self::FONT_STACKS[$token] ?? null);
    }

    /** Whether a stored variable name belongs to the font-token set. */
    public static function isFontVar(string $name): bool
    {
        return in_array($name, self::FONT_VARS, true);
    }

    /**
     * Re-validate a STORED css_vars map, keeping raw values (font TOKENS
     * intact — what the edit panel needs). Anything failing re-validation is
     * dropped: defense in depth against a bad value that reached the DB.
     *
     * @return array<string,string>
     */
    public function cleanStored(?array $cssVars): array
    {
        if (!$cssVars) {
            return [];
        }
        $out = [];
        foreach ($cssVars as $name => $value) {
            if (is_string($name) && is_string($value) && $this->validateVar($name, $value) === true) {
                $out[$name] = $value;
            }
        }
        return $out;
    }

    /**
     * Render-safe emission of a stored css_vars map: cleanStored() plus font
     * tokens expanded to stacks. The blade prints the result inside a <style>
     * block (through {{ }} — every value is quote-free by construction).
     *
     * @return array<string,string>
     */
    public function emittable(?array $cssVars): array
    {
        $out = [];
        foreach ($this->cleanStored($cssVars) as $name => $value) {
            if (self::isFontVar($name)) {
                $stack = self::fontStack($value);
                if ($stack !== null) {
                    $out[$name] = $stack;
                }
                continue;
            }
            $out[$name] = $value;
        }
        return $out;
    }
}
