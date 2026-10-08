<?php

namespace App\Services\Translation;

use App\Services\LlmService;

/**
 * Translates a whole HTML document — a book — keeping its markup intact.
 *
 * WORKFLOW (ported from the standalone Fireworks book-translation script):
 *   - The document splits into SECTIONS at h1–h3 headings (chapters), or every
 *     services.translation.html.section_chars when it has none.
 *   - Within a section, paragraphs go to the model in batches of ~batch_chars
 *     as a JSON object {id: paragraph}, preceded by the previous few
 *     translations as context, so names and pronouns carry across batches.
 *     Batches within a section are strictly sequential; up to `workers`
 *     sections are in flight at once.
 *   - An optional glossary pins the rendering of names and terms; an optional
 *     character list gives genders, for pronouns where the source omits the
 *     subject (Chinese routinely does).
 *   - Every finished paragraph goes to a JSON cache file, so a crashed or
 *     partly failed run resumes where it stopped.
 *
 * WHAT A PARAGRAPH IS: a run of inline content — a <p>, a heading, a list
 * item, a table cell, or one line of a novel whose paragraphs are separated
 * by nothing but <br>. Inline elements inside are swapped for numbered
 * placeholders before the model sees them:
 *   <gN>…</gN>  an element whose words are translated (em, a, u, span, …)
 *   <xN/>       an element kept byte-for-byte (footnote markers, hypercite
 *               arrows, citations, math, code, images)
 * The answer is rebuilt from clones of the ORIGINAL elements, so ids, hrefs and
 * data attributes never pass through the model at all. A paragraph whose
 * placeholders keep coming back broken is retried text node by text node:
 * worse prose, guaranteed structure.
 *
 * ⚠ NOT A WAY TO OVERWRITE A BOOK'S NODES. Hyperlights and hypercites store
 * character offsets into the original text (charData) and nothing here
 * realigns them. The output is a new document.
 *
 * Requests go through LlmService::chatBatch, so tokens land in the same
 * per-model usage counters billing prices from. Not reentrant: one
 * translate() per instance at a time (the container hands out a fresh one).
 */
final class HtmlTranslator
{
    /** Elements that end one paragraph and start another. Anything unlisted is inline. */
    private const BLOCK_TAGS = [
        'html', 'head', 'body', 'title', 'main', 'article', 'section', 'nav', 'aside', 'header', 'footer',
        'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'blockquote', 'address', 'center',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'details', 'summary',
        'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'form', 'fieldset', 'legend',
    ];

    /**
     * End a paragraph like a block, but nothing inside is translated. <br> is
     * here because web novels separate paragraphs with nothing else — as one
     * run, a chapter would be a single 6,000-character "paragraph".
     */
    private const OPAQUE_BLOCK_TAGS = ['br', 'pre', 'hr', 'latex-block', 'textarea', 'template'];

    /** Inline elements carried through verbatim as a single <xN/>. */
    private const KEPT_TAGS = [
        'script', 'style', 'noscript', 'code', 'kbd', 'samp', 'latex', 'svg', 'math',
        'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object', 'wbr', 'input', 'select',
    ];

    /**
     * Hyperlit furniture that is not language — the set TranslatableText drops,
     * plus citations, kept verbatim so author names and reference numbers are
     * never "translated".
     */
    private const KEPT_CLASSES = ['footnote-ref', 'open-icon', 'pageNumber', 'in-text-citation'];

    /**
     * Marks a synthetic wrapper this class adds around a citation and the
     * author name in front of it, so the pair travels as ONE <xN/>.
     *
     * The docblock above has always claimed citations are "kept verbatim so
     * author names … are never translated", but the markup does not support
     * it: the linker wraps only the YEAR —
     *   (UN <a class="in-text-citation">1974a</a>, <a …>1974b</a>)
     * — so the author sits outside the anchor as plain text and goes to the
     * model as prose. Measured on a real en→zh run: 22 of 101 citations came
     * back as 墨菲1984 / 普拉沙德2007 / 伯杰和韦伯2014, Chinese author with an
     * intact Latin year. The bibliography is deliberately NOT translated, so
     * each of those keys is orphaned — unmatchable by a reader, by citation
     * resolution and by hypercites.
     *
     * Protection, not instruction: rebuild() already enforces that every
     * placeholder comes back exactly once, so this is machine-checked. A
     * prompt rule is what the model was already following 79 times out of 101.
     *
     * NEVER reaches stored content — unwrapProtectedCitations() removes it at
     * the end of process(), which both entry points go through.
     */
    private const KEEP_ATTR = 'data-translate-keep';

    /** How far back from an anchor an author name may possibly start. */
    private const AUTHOR_RUN_MAX_CHARS = 60;

    /**
     * A paragraph in one of these starts a new section (chapter). <title> is
     * one so it joins the front matter instead of being a section by itself —
     * otherwise --chapters=2 would buy a page title and a table of contents.
     */
    private const SECTION_HEADINGS = ['title', 'h1', 'h2', 'h3'];

    /** Edge whitespace a paragraph keeps verbatim: novel indents are &nbsp; or U+3000. */
    private const EDGE_SPACE = '[\s\x{00A0}\x{3000}]';

    /**
     * State of the translate() call in progress: the DOM, the target script,
     * the cache, and the counters the result reports.
     */
    private array $run = [];

    public function __construct(
        private readonly LlmService $llm,
        private readonly LanguageRegistry $registry,
    ) {}

    /**
     * What a translate() call would send, without sending anything — the
     * --dry-run numbers.
     *
     * @return array{sections: int, segments: int, chars: int}
     */
    public function measure(string $html): array
    {
        $parsed = $this->parse($html);
        $segments = $parsed === null ? [] : $this->segments($parsed['root']);

        return [
            'sections' => count($this->sections($segments)),
            'segments' => count($segments),
            'chars' => array_sum(array_map(fn (array $s): int => mb_strlen($s['text']), $segments)),
        ];
    }

    /**
     * Translate a whole document (<!DOCTYPE>/<html>) or a fragment. A paragraph
     * that fails every attempt is left in the source language and counted, not
     * fatal — the caller decides whether a partial result is usable (with a
     * cache, rerunning retries exactly those).
     *
     * @param  array<string, string>  $glossary  source term => rendering to always use
     * @param  array<string, string>  $characters  name => gender, for pronouns
     * @param  string|null  $about  what the text is, e.g. "a Chinese xianxia/historical romance novel"
     * @param  int|null  $sectionLimit  translate only the first N sections (a cheap trial)
     * @param  string|null  $cachePath  JSON file of finished paragraphs, read and kept up to date
     * @param  (callable(array $event): void)|null  $onProgress  'section' / 'batch' / 'section_done' events
     *
     * @throws UnsupportedLanguageException|TranslationProviderException
     */
    public function translate(
        string $html,
        string $targetLang,
        ?string $sourceLang = null,
        array $glossary = [],
        array $characters = [],
        ?string $about = null,
        ?int $sectionLimit = null,
        ?string $cachePath = null,
        ?callable $onProgress = null,
    ): HtmlTranslationResult {
        // Before parsing: an unknown target must fail before any spend.
        [$target, $source] = $this->resolveLanguages($targetLang, $sourceLang);

        $parsed = $this->parse($html);
        if ($parsed === null) {
            throw new TranslationProviderException('The HTML could not be parsed.');
        }

        if ($parsed['document'] && self::tag($parsed['root']) === 'html') {
            // A stale lang="zh" on an English page has browsers pick CJK fonts
            // and line-breaking for the prose.
            $parsed['root']->setAttribute('lang', $target);
        }

        $stats = $this->process($parsed, $target, $source, $glossary, $characters, $about, $sectionLimit, $cachePath, $onProgress, null);

        return $this->result($stats, $target, $source, $targetLang, html: $this->serialize($parsed));
    }

    /**
     * Translate a book's nodes (or its footnotes) as ONE document — so
     * sections, batching and context flow across node boundaries exactly as in
     * a single HTML file — and hand each back separately, keyed as given.
     *
     * Each fragment is parsed on its own and placed in its own wrapper <div>,
     * a block boundary no paragraph can cross, so a node with unbalanced
     * markup can't swallow its neighbours.
     *
     * $deadline (a microtime) stops starting new batches once passed; whatever
     * wasn't reached is counted as `pending` and left untranslated, for a
     * caller that resumes from the same cache (a queue job handing off before
     * its timeout).
     *
     * @param  array<string|int, string>  $fragments
     *
     * @throws UnsupportedLanguageException|TranslationProviderException
     */
    public function translateFragments(
        array $fragments,
        string $targetLang,
        ?string $sourceLang = null,
        array $glossary = [],
        array $characters = [],
        ?string $about = null,
        ?string $cachePath = null,
        ?callable $onProgress = null,
        ?float $deadline = null,
    ): HtmlTranslationResult {
        [$target, $source] = $this->resolveLanguages($targetLang, $sourceLang);

        $parsed = $this->parse('');
        if ($parsed === null) {
            throw new TranslationProviderException('Could not start an HTML document.');
        }

        $wrappers = [];
        foreach ($fragments as $key => $html) {
            $wrapper = $parsed['dom']->createElement('div');
            $parsed['root']->appendChild($wrapper);
            $wrappers[$key] = $wrapper;

            $own = $this->parse((string) $html);
            if ($own === null) {
                continue; // unparseable: comes back as an empty fragment
            }
            foreach (iterator_to_array($own['root']->childNodes) as $child) {
                $wrapper->appendChild($parsed['dom']->importNode($child, true));
            }
        }

        $stats = $this->process($parsed, $target, $source, $glossary, $characters, $about, null, $cachePath, $onProgress, $deadline);

        $translated = [];
        foreach ($wrappers as $key => $wrapper) {
            $translated[$key] = '';
            foreach (iterator_to_array($wrapper->childNodes) as $child) {
                $translated[$key] .= $parsed['dom']->saveHTML($child);
            }
        }

        return $this->result($stats, $target, $source, $targetLang, fragments: $translated);
    }

    /** @return array{0: string, 1: ?string} canonical target and source codes */
    private function resolveLanguages(string $targetLang, ?string $sourceLang): array
    {
        $target = $this->registry->normalize($targetLang);
        if ($target === null) {
            throw new UnsupportedLanguageException(
                "Unknown language code '{$targetLang}'.",
                UnsupportedLanguageException::REASON_UNKNOWN,
                $targetLang,
            );
        }
        $source = $sourceLang === null || trim($sourceLang) === '' ? null : $this->registry->normalize($sourceLang);

        return [$target, $source];
    }

    private function result(array $stats, string $target, ?string $source, string $requestedTarget, string $html = '', array $fragments = []): HtmlTranslationResult
    {
        $failed = $this->run['failed'];
        $pending = $stats['pending'];

        return new HtmlTranslationResult(
            html: $html,
            targetLang: $target,
            sourceLang: $source,
            model: $stats['model'],
            sections: $stats['sections'],
            segments: $stats['segments'],
            translated: count($this->run['translated']),
            fallbacks: count(array_diff_key($this->run['fallback'], $failed, $pending)),
            failed: count($failed),
            cached: $this->run['cached'],
            wrongScript: $this->run['wrongScript'],
            targetWasAmbiguous: $this->registry->isAmbiguousInput($requestedTarget),
            fragments: $fragments,
            pending: count($pending),
        );
    }

    /**
     * The translation loop, shared by translate() and translateFragments():
     * sections in parallel, batches in order within each, every answer applied
     * to the DOM in $parsed as it lands.
     *
     * @return array{model: string, sections: int, segments: int, pending: array<int, true>}
     */
    private function process(
        array $parsed,
        string $target,
        ?string $source,
        array $glossary,
        array $characters,
        ?string $about,
        ?int $sectionLimit,
        ?string $cachePath,
        ?callable $onProgress,
        ?float $deadline,
    ): array {
        $config = config('services.translation.html');
        $model = $config['model'];
        $effort = $config['reasoning_effort'] ?? (str_ends_with($model, '/kimi-k3') ? 'low' : null);
        $system = $this->systemPrompt($target, $source, $about, $glossary, $characters);

        $this->run = [
            'dom' => $parsed['dom'],
            'target' => $target,
            'script' => $this->registry->scriptOf($target),
            'cache' => $this->loadCache($cachePath),
            'translated' => [],
            'fallback' => [],
            'failed' => [],
            'cached' => 0,
            'wrongScript' => 0,
            'done' => 0,
        ];

        $all = $this->sections($this->segments($parsed['root']));
        if ($sectionLimit !== null && $sectionLimit > 0) {
            $all = array_slice($all, 0, $sectionLimit);
        }

        $state = [];
        $segmentCount = 0;
        $total = 0; // characters still to translate — cached paragraphs aren't work
        foreach ($all as $i => $section) {
            $queue = [];
            foreach ($section['segments'] as $segment) {
                $queue[] = ['kind' => 'segment', 'id' => $segment['id'], 'seg' => $segment, 'text' => $segment['text'], 'attempts' => 0];
                if (! isset($this->run['cache'][$this->cacheKey($segment['text'])])) {
                    $total += mb_strlen($segment['text']);
                }
            }
            $state[$i] = ['queue' => $queue, 'context' => []];
            $segmentCount += count($queue);
        }

        $pending = array_keys($state);
        $active = [];
        $failures = 0;

        while ($active !== [] || $pending !== []) {
            if ($deadline !== null && microtime(true) >= $deadline) {
                break; // out of time: what's left stays queued, reported as pending
            }

            while (count($active) < max(1, (int) $config['workers']) && $pending !== []) {
                $i = array_shift($pending);
                $active[] = $i;
                $this->emit($onProgress, [
                    'type' => 'section', 'section' => $i + 1, 'sections' => count($all),
                    'title' => $all[$i]['title'], 'paragraphs' => count($state[$i]['queue']),
                ]);
            }

            $requests = [];
            $batches = [];
            foreach ($active as $i) {
                $batch = $this->takeBatch($state[$i], (int) $config['batch_chars']);
                if ($batch === []) {
                    $active = array_values(array_diff($active, [$i]));
                    $this->emit($onProgress, ['type' => 'section_done', 'section' => $i + 1, 'sections' => count($all)]);

                    continue;
                }

                $batches[$i] = $batch;
                $requests[$i] = [
                    'system' => $system,
                    'user' => $this->userMessage($batch, array_slice($state[$i]['context'], -(int) $config['context_paragraphs'])),
                    'model' => $model,
                    'temperature' => (float) $config['temperature'],
                    'max_tokens' => (int) $config['max_tokens'],
                    'reasoning_effort' => $effort,
                ];
            }
            if ($requests === []) {
                continue;
            }

            $started = microtime(true);
            $answers = $this->llm->chatBatch($requests, (int) $config['timeout']);
            $seconds = microtime(true) - $started;

            $outright = false;
            foreach ($batches as $i => $batch) {
                $translations = $this->parseAnswer($answers[$i] ?? null);
                $outright = $outright || $translations === null;
                $retried = $this->settle($state[$i], $batch, $translations ?? []);

                $this->emit($onProgress, [
                    'type' => 'batch', 'section' => $i + 1, 'sections' => count($all),
                    'paragraphs' => count($batch), 'retried' => $retried,
                    'chars' => array_sum(array_map(fn (array $item): int => mb_strlen($item['text']), $batch)),
                    'seconds' => $seconds, 'done' => $this->run['done'], 'total' => $total,
                ]);
            }
            $this->saveCache($cachePath);

            // A request that failed outright (429, 5xx, timeout, no JSON at all)
            // is retried next round; back off first, doubling, as the script did.
            $failures = $outright ? $failures + 1 : 0;
            $delay = (int) $config['retry_backoff'] * 2 ** min(max($failures - 1, 0), 3);
            if ($outright && $delay > 0) {
                sleep($delay);
            }
        }

        // Anything still queued when the loop stopped early (the deadline) was
        // never finished: pending, not failed.
        $unfinished = [];
        foreach ($state as $section) {
            foreach ($section['queue'] as $item) {
                $unfinished[$item['id']] = true;
            }
        }

        // The synthetic citation wrappers must not outlive the translation:
        // both entry points serialize this DOM straight into stored content.
        $this->unwrapProtectedCitations($parsed['root']);

        return ['model' => $model, 'sections' => count($all), 'segments' => $segmentCount, 'pending' => $unfinished];
    }

    /**
     * Built from the script's prompt, generalised past one novel and one
     * language pair. The quotation-mark and pinyin rules are phrased so they
     * only bite when the source really is Chinese.
     */
    private function systemPrompt(string $target, ?string $source, ?string $about, array $glossary, array $characters): string
    {
        $targetName = $this->registry->promptName($target);
        $from = $source !== null ? ' from '.$this->registry->promptName($source) : '';
        $what = trim((string) $about) !== '' ? trim((string) $about) : 'the text';

        $lines = [
            "You are a literary translator rendering {$what}{$from} into polished, natural {$targetName} prose for readers of {$targetName}.",
            '- Preserve tone, dialogue and meaning; do not summarise, add or omit content.',
        ];

        $script = $this->registry->scriptInstruction($target);
        if ($script !== '') {
            $lines[] = '- '.$script;
        }

        if (in_array($this->registry->scriptOf($target), ['Hans', 'Hant'], true)) {
            $lines[] = "- Use {$targetName} punctuation, including “” for quotations.";
        } else {
            $lines[] = '- Romanise Chinese personal names and places in pinyin unless the glossary says otherwise.';
            $lines[] = "- Convert Chinese quotation marks “” and 「」 to {$targetName} quotation marks.";
        }

        $lines[] = '- Some paragraphs contain placeholder tags such as <g1>…</g1> and <x2/> standing for formatting, links and footnote markers. Keep every placeholder exactly as written and exactly once, put each <gN>…</gN> pair around the translation of the words it enclosed (reordering where the grammar requires), and add no other markup.';

        if ($glossary !== []) {
            $lines[] = "Glossary (always use these renderings):\n"
                .implode("\n", array_map(fn ($k, $v) => "{$k} = {$v}", array_keys($glossary), $glossary));
        }
        if ($characters !== []) {
            $lines[] = "Character genders (use for correct pronouns, especially where the source omits the subject; never write these notes into the translation):\n"
                .implode("\n", array_map(fn ($k, $v) => "{$k}: {$v}", array_keys($characters), $characters));
        }

        $lines[] = 'You will receive a JSON object mapping ids to paragraphs. Return ONLY a JSON object with exactly the same ids mapped to their translations. No commentary, no code fences.';

        return implode("\n", $lines);
    }

    /** @param  list<string>  $context */
    private function userMessage(array $batch, array $context): string
    {
        $payload = [];
        foreach ($batch as $n => $item) {
            $payload[(string) $n] = $item['text'];
        }

        // FORCE_OBJECT: ids 0..n would otherwise encode as a JSON array.
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_FORCE_OBJECT);

        return $context === []
            ? $json
            : "Previous translated paragraphs (context only, do not return):\n".implode("\n", $context)."\n\n".$json;
    }

    /**
     * The id => translation object out of a reply, or null when there is none.
     * Reasoning models may inline <think>…</think>; others add fences or prose.
     *
     * @return array<int|string, mixed>|null
     */
    private function parseAnswer(?string $raw): ?array
    {
        if ($raw === null) {
            return null;
        }

        $text = trim(preg_replace('/<think>.*?<\/think>/s', '', $raw) ?? $raw);
        $text = preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $text) ?? $text;

        $decoded = json_decode($text, true);
        if (! is_array($decoded)) {
            $start = strpos($text, '{');
            $end = strrpos($text, '}');
            if ($start !== false && $end !== false && $end > $start) {
                $decoded = json_decode(substr($text, $start, $end - $start + 1), true);
            }
        }

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Next batch for a section: up to $limit source characters (a single
     * longer paragraph goes alone). Cached paragraphs are applied on the way
     * past rather than sent.
     */
    private function takeBatch(array &$section, int $limit): array
    {
        $batch = [];
        $chars = 0;

        while ($section['queue'] !== []) {
            $item = $section['queue'][0];
            $key = $this->cacheKey($item['text']);

            if (isset($this->run['cache'][$key])) {
                array_shift($section['queue']);
                $requeue = [];
                $this->apply($item, $this->run['cache'][$key], $section, $requeue, fromCache: true);
                if ($requeue === []) {
                    $this->run['cached']++;
                } else {
                    // A cached answer that no longer fits (shouldn't happen) is resent.
                    unset($this->run['cache'][$key]);
                    array_splice($section['queue'], 0, 0, $requeue);
                }

                continue;
            }

            $length = mb_strlen($item['text']);
            if ($batch !== [] && $chars + $length > $limit) {
                break;
            }
            array_shift($section['queue']);
            $batch[] = $item;
            $chars += $length;
        }

        return $batch;
    }

    /**
     * Apply a batch's answers; anything to retry goes back on the FRONT of the
     * section's queue, in order, so it is next.
     *
     * @return int how many were requeued
     */
    private function settle(array &$section, array $batch, array $translations): int
    {
        $requeue = [];
        foreach ($batch as $n => $item) {
            $answer = $translations[$n] ?? null;
            if (! is_string($answer) || trim($answer) === '') {
                $this->retryOrFail($item, $requeue);

                continue;
            }
            $this->apply($item, $answer, $section, $requeue);
        }

        array_splice($section['queue'], 0, 0, $requeue);

        return count($requeue);
    }

    private function apply(array $item, string $answer, array &$section, array &$requeue, bool $fromCache = false): void
    {
        $answer = trim($answer);
        $plain = self::stripPlaceholders($answer);
        $scriptOk = ScriptDetector::matches($plain, $this->run['script']);

        // The wrong script usually means the model echoed the source: worth one
        // more try before accepting it.
        if (! $scriptOk && ! $fromCache && $item['attempts'] === 0 && $this->maxAttempts() > 1) {
            $requeue[] = ['attempts' => 1] + $item;

            return;
        }

        if ($item['kind'] === 'segment') {
            $fragment = $this->rebuild($answer, $item['seg']);
            if ($fragment === null) {
                if ($this->maxAttempts() > $item['attempts'] + 1) {
                    $requeue[] = ['attempts' => $item['attempts'] + 1] + $item;

                    return;
                }
                // Out of attempts with the markup intact: translate its text
                // nodes one by one instead, each with fresh attempts.
                $this->run['fallback'][$item['id']] = true;
                array_push($requeue, ...$this->nodeItems($item));

                return;
            }
            $this->replaceRun($item['seg'], $fragment);
            $this->run['translated'][$item['id']] = true;
        } else {
            $item['node']->data = $item['lead'].$answer.$item['trail'];
        }

        if (! $scriptOk) {
            $this->run['wrongScript']++;
        }
        $this->run['cache'][$this->cacheKey($item['text'])] = $answer;
        if (! $fromCache) {
            $this->run['done'] += mb_strlen($item['text']);
        }
        $section['context'][] = $plain;
    }

    private function retryOrFail(array $item, array &$requeue): void
    {
        if ($this->maxAttempts() > $item['attempts'] + 1) {
            $requeue[] = ['attempts' => $item['attempts'] + 1] + $item;

            return;
        }

        $this->run['failed'][$item['id']] = true;
    }

    /** A segment's text nodes as fallback items, each keeping its own edge whitespace. */
    private function nodeItems(array $item): array
    {
        $items = [];
        foreach ($this->textNodes($item['seg']['nodes']) as $node) {
            [$lead, $core, $trail] = self::splitEdges($node->data);
            $items[] = [
                'kind' => 'node', 'id' => $item['id'], 'node' => $node, 'attempts' => 0,
                'text' => preg_replace('/[ \t\n\r\f]+/', ' ', $core) ?? $core,
                'lead' => $lead, 'trail' => $trail,
            ];
        }

        return $items;
    }

    private function maxAttempts(): int
    {
        return max(1, (int) config('services.translation.html.max_attempts', 4));
    }

    private function cacheKey(string $text): string
    {
        return sha1($this->run['target']."\n".$text);
    }

    /** @return array<string, string> */
    private function loadCache(?string $path): array
    {
        if ($path === null || ! is_file($path)) {
            return [];
        }
        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? array_filter($decoded, 'is_string') : [];
    }

    private function saveCache(?string $path): void
    {
        if ($path === null) {
            return;
        }
        // Write-then-rename, so a crash mid-write can't corrupt the progress.
        $tmp = $path.'.tmp';
        file_put_contents($tmp, json_encode($this->run['cache'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        rename($tmp, $path);
    }

    private function emit(?callable $onProgress, array $event): void
    {
        if ($onProgress !== null) {
            $onProgress($event);
        }
    }

    /**
     * Group paragraphs into sections: a heading starts one once the current
     * section has body text (so a book title and its first chapter heading
     * stay together), and a section never grows past section_chars.
     *
     * @return list<array{title: string, segments: list<array>}>
     */
    private function sections(array $segments): array
    {
        $maxChars = max(1, (int) config('services.translation.html.section_chars', 40000));
        $sections = [];
        $current = null;

        foreach ($segments as $segment) {
            $length = mb_strlen($segment['text']);
            if ($current !== null && (($segment['heading'] && $current['body']) || $maxChars < $current['chars'] + $length)) {
                $sections[] = ['title' => $current['title'], 'segments' => $current['segments']];
                $current = null;
            }

            $current ??= ['title' => mb_strimwidth(self::stripPlaceholders($segment['text']), 0, 60, '…'), 'segments' => [], 'chars' => 0, 'body' => false];
            $current['segments'][] = $segment;
            $current['chars'] += $length;
            $current['body'] = $current['body'] || ! $segment['heading'];
        }

        if ($current !== null) {
            $sections[] = ['title' => $current['title'], 'segments' => $current['segments']];
        }

        return $sections;
    }

    /** @return array{dom: \DOMDocument, root: \DOMElement, document: bool, doctype: ?string}|null */
    private function parse(string $html): ?array
    {
        $html = preg_replace('/^\x{FEFF}/u', '', $html) ?? $html;
        $document = preg_match('/<!doctype\s|<html[\s>]/i', $html) === 1;

        $dom = new \DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        // Same loading recipe as TranslatableText / NodeHtmlSanitizer (force
        // UTF-8; fragments wrapped so exactly they can be recovered), plus
        // PARSEHUGE: a whole book in one file exceeds libxml's default limits.
        $loaded = $document
            ? $dom->loadHTML('<?xml encoding="utf-8"?>'.$html, LIBXML_NONET | LIBXML_PARSEHUGE)
            : $dom->loadHTML(
                '<?xml encoding="utf-8"?><div data-html-translator-root="1">'.$html.'</div>',
                LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NONET | LIBXML_PARSEHUGE
            );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        if (! $loaded) {
            return null;
        }

        $root = $document ? $dom->documentElement : $dom->getElementsByTagName('div')->item(0);
        if (! $root instanceof \DOMElement) {
            return null;
        }

        preg_match('/^\s*(<!doctype[^>]*>)/i', $html, $doctype);

        // Before anything reads the tree: bind each citation's author to its
        // anchor so the pair is kept verbatim. Undone at the end of process().
        $this->protectCitations($root);

        return ['dom' => $dom, 'root' => $root, 'document' => $document, 'doctype' => $doctype[1] ?? null];
    }

    /**
     * Node by node, never a bare $dom->saveHTML(): whole-document output
     * entity-encodes every non-ASCII character (a Chinese page becomes
     * &#38271;&#30456;… and grows sixfold) and invents an HTML 4 doctype when
     * the source had none. Per-node output keeps raw UTF-8, so the source's own
     * doctype is carried over verbatim instead.
     */
    private function serialize(array $parsed): string
    {
        $dom = $parsed['dom'];
        $out = '';

        if (! $parsed['document']) {
            foreach (iterator_to_array($parsed['root']->childNodes) as $child) {
                $out .= $dom->saveHTML($child);
            }

            return $out;
        }

        if ($parsed['doctype'] !== null) {
            $out .= $parsed['doctype']."\n";
        }
        foreach (iterator_to_array($dom->childNodes) as $child) {
            if ($child instanceof \DOMDocumentType || $child instanceof \DOMProcessingInstruction) {
                continue;
            }
            $out .= $dom->saveHTML($child);
        }

        return $out."\n";
    }

    /**
     * Every paragraph worth translating, in document order, with the
     * placeholder text the model will see.
     *
     * @return list<array{id: int, nodes: list<\DOMNode>, map: array<int, array{0: \DOMElement, 1: bool}>, text: string, lead: string, trail: string, heading: bool}>
     */
    private function segments(\DOMElement $root): array
    {
        $runs = [];
        $this->collectRuns($root, $runs);

        $segments = [];
        foreach ($runs as $id => $run) {
            $map = [];
            $encoded = preg_replace('/ {2,}/', ' ', $this->encode($run['nodes'], $map)) ?? '';
            [$lead, $text, $trail] = self::splitEdges($encoded);
            $segments[] = [
                'id' => $id,
                'nodes' => $run['nodes'],
                'map' => $map,
                'text' => $text,
                'lead' => $lead,
                'trail' => $trail,
                'heading' => $run['heading'],
            ];
        }

        return $segments;
    }

    /**
     * Walk the block structure, gathering maximal runs of inline siblings. A
     * block child (or an inline element wrapping one, which messy HTML has)
     * ends the current run and is walked in turn. Comments end a run too, so
     * they keep their position when the run is replaced.
     *
     * @param  list<array{nodes: list<\DOMNode>, heading: bool}>  $runs
     */
    private function collectRuns(\DOMElement $container, array &$runs): void
    {
        $heading = in_array(self::tag($container), self::SECTION_HEADINGS, true);
        $run = [];
        foreach (iterator_to_array($container->childNodes) as $child) {
            if ($child instanceof \DOMText || ($child instanceof \DOMElement && ! $this->isContainer($child))) {
                $run[] = $child;

                continue;
            }

            $this->closeRun($run, $heading, $runs);
            $run = [];

            if ($child instanceof \DOMElement
                && ! in_array(self::tag($child), self::OPAQUE_BLOCK_TAGS, true)
                && ! $this->isFurniture($child)) {
                $this->collectRuns($child, $runs);
            }
        }
        $this->closeRun($run, $heading, $runs);
    }

    /** @param  list<array{nodes: list<\DOMNode>, heading: bool}>  $runs */
    private function closeRun(array $run, bool $heading, array &$runs): void
    {
        // Whitespace between blocks stays where it is, outside the paragraph.
        while ($run !== [] && self::isBlank($run[0])) {
            array_shift($run);
        }
        while ($run !== [] && self::isBlank(end($run))) {
            array_pop($run);
        }

        // Nothing to pay for in a run of digits and punctuation ("[9]", "1867").
        if ($run !== [] && preg_match('/\p{L}/u', $this->translatableText($run)) === 1) {
            $runs[] = ['nodes' => $run, 'heading' => $heading];
        }
    }

    /**
     * The model's view of a run: text with whitespace collapsed (HTML renders
     * it collapsed anyway), elements as numbered placeholders. $map records
     * which original element each number stands for, and whether it is kept.
     *
     * @param  iterable<\DOMNode>  $nodes
     * @param  array<int, array{0: \DOMElement, 1: bool}>  $map
     */
    private function encode(iterable $nodes, array &$map): string
    {
        $out = '';
        foreach ($nodes as $node) {
            if ($node instanceof \DOMText) {
                $out .= preg_replace('/[ \t\n\r\f]+/', ' ', $node->data);

                continue;
            }
            if (! $node instanceof \DOMElement) {
                continue; // a comment inside inline markup; not carried through
            }

            $id = count($map) + 1;
            $kept = $this->isKept($node);
            $map[$id] = [$node, $kept];
            $out .= $kept ? "<x{$id}/>" : "<g{$id}>".$this->encode($node->childNodes, $map)."</g{$id}>";
        }

        return $out;
    }

    /**
     * The model's answer turned back into DOM, built from clones of the
     * original elements. Null unless every placeholder comes back exactly once
     * and properly nested: guessing where a dropped footnote marker belonged
     * would put it somewhere wrong, silently.
     */
    private function rebuild(string $answer, array $segment): ?\DOMDocumentFragment
    {
        $dom = $this->run['dom'];
        $map = $segment['map'];
        // Models sometimes answer markup-looking input with HTML entities. Only
        // decode when the source had no '&' at all, so a literal "&amp;" in the
        // source can't be double-decoded.
        $decode = ! str_contains($segment['text'], '&');

        $fragment = $dom->createDocumentFragment();
        $stack = [$fragment];
        $open = [];
        $seen = [];

        $parts = preg_split('/(<\s*\/?\s*[gx]\d+\s*\/?\s*>)/i', $answer, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) ?: [];
        foreach ($parts as $part) {
            if (preg_match('/^<\s*(\/?)\s*([gx])(\d+)\s*(\/?)\s*>$/i', $part, $m) !== 1) {
                $text = $decode ? html_entity_decode($part, ENT_QUOTES | ENT_HTML5, 'UTF-8') : $part;
                end($stack)->appendChild($dom->createTextNode($text));

                continue;
            }

            [, $closing, $kind, $id, $selfClosing] = $m;
            $id = (int) $id;
            $isKept = strtolower($kind) === 'x';
            if (! isset($map[$id]) || $map[$id][1] !== $isKept) {
                return null; // invented, or the wrong kind
            }

            if ($closing !== '') {
                if ($isKept || end($open) !== $id) {
                    return null; // closes something other than the innermost open pair
                }
                array_pop($open);
                array_pop($stack);

                continue;
            }

            if (isset($seen[$id]) || (! $isKept && $selfClosing !== '')) {
                return null; // duplicated, or a <gN/> whose words went missing
            }
            $seen[$id] = true;

            if ($isKept) {
                end($stack)->appendChild($map[$id][0]->cloneNode(true));

                continue;
            }

            $clone = $map[$id][0]->cloneNode(false);
            end($stack)->appendChild($clone);
            $stack[] = $clone;
            $open[] = $id;
        }

        return $open === [] && count($seen) === count($map) ? $fragment : null;
    }

    private function replaceRun(array $segment, \DOMDocumentFragment $fragment): void
    {
        $first = $segment['nodes'][0];
        $parent = $first->parentNode;
        $dom = $first->ownerDocument;

        if ($segment['lead'] !== '') {
            $parent->insertBefore($dom->createTextNode($segment['lead']), $first);
        }
        if ($segment['trail'] !== '') {
            $fragment->appendChild($dom->createTextNode($segment['trail']));
        }
        if ($fragment->hasChildNodes()) {
            $parent->insertBefore($fragment, $first);
        }
        foreach ($segment['nodes'] as $node) {
            $parent->removeChild($node);
        }
    }

    /**
     * Text nodes with letters in them, skipping kept elements.
     *
     * @param  iterable<\DOMNode>  $nodes
     * @return list<\DOMText>
     */
    private function textNodes(iterable $nodes): array
    {
        $out = [];
        foreach ($nodes as $node) {
            if ($node instanceof \DOMText) {
                if (preg_match('/\p{L}/u', $node->data) === 1) {
                    $out[] = $node;
                }
            } elseif ($node instanceof \DOMElement && ! $this->isKept($node)) {
                array_push($out, ...$this->textNodes($node->childNodes));
            }
        }

        return $out;
    }

    /** @param  iterable<\DOMNode>  $nodes */
    private function translatableText(iterable $nodes): string
    {
        $text = '';
        foreach ($nodes as $node) {
            if ($node instanceof \DOMText) {
                $text .= $node->data;
            } elseif ($node instanceof \DOMElement && ! $this->isKept($node)) {
                $text .= $this->translatableText($node->childNodes);
            }
        }

        return $text;
    }

    private function isContainer(\DOMElement $el): bool
    {
        $isBlockTag = fn (\DOMElement $e): bool => in_array(self::tag($e), self::BLOCK_TAGS, true)
            || in_array(self::tag($e), self::OPAQUE_BLOCK_TAGS, true);

        if ($isBlockTag($el)) {
            return true;
        }
        if ($this->isKept($el)) {
            return false;
        }
        foreach ($el->getElementsByTagName('*') as $descendant) {
            if ($isBlockTag($descendant)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Carried through verbatim as one <xN/>: never-translated tags, Hyperlit's
     * non-language furniture, and anything with no letters in it (a bare "2"
     * superscript, an empty anchor) — sending those as a <gN> pair only gives
     * the model something to lose.
     */
    private function isKept(\DOMElement $el): bool
    {
        return in_array(self::tag($el), self::KEPT_TAGS, true)
            || $this->isFurniture($el)
            || preg_match('/\p{L}/u', $this->translatableText($el->childNodes)) !== 1;
    }

    /**
     * Wrap "author + citation anchor" pairs so the author rides the anchor's
     * placeholder. Runs on every parse(), so every entry point gets it.
     *
     * Two shapes only, deliberately narrow — over-absorbing would leave
     * untranslated English sitting in the middle of Chinese prose, which is
     * worse than the bug:
     *   parenthetical  "… the NIEO (UN 1974a)"        → absorbs "UN"
     *   narrative      "… According to Prashad (2007)" → absorbs "Prashad"
     * An anchor with no author in front of it (the second of "1974a, 1974b")
     * is left alone: it is already kept verbatim on its own.
     */
    private function protectCitations(\DOMElement $root): void
    {
        $anchors = [];
        foreach ($root->getElementsByTagName('a') as $anchor) {
            if (self::hasClass($anchor, 'in-text-citation')) {
                $anchors[] = $anchor;
            }
        }

        foreach ($anchors as $anchor) {
            $previous = $anchor->previousSibling;
            $parent = $anchor->parentNode;
            if (! $previous instanceof \DOMText || ! $parent instanceof \DOMNode) {
                continue;
            }
            $start = $this->authorRunStart($previous->data);
            if ($start === null) {
                continue;
            }

            // Split by hand rather than DOMText::splitText, whose offset is
            // bytes in PHP's libxml binding — a multibyte author would tear.
            $author = mb_substr($previous->data, $start);
            $previous->data = mb_substr($previous->data, 0, $start);

            $span = $anchor->ownerDocument->createElement('span');
            $span->setAttribute(self::KEEP_ATTR, '1');
            $parent->insertBefore($span, $anchor);
            $span->appendChild($anchor->ownerDocument->createTextNode($author));
            $span->appendChild($anchor); // moves it out of the run and into the span
        }
    }

    /**
     * Remove the synthetic wrappers. MANDATORY: translate() and
     * translateFragments() both serialize the same DOM this mutated, and
     * rebuild() reinserts a CLONE of the wrapper — left in, it would be
     * persisted into nodes.content by BookTranslationService::run().
     */
    private function unwrapProtectedCitations(\DOMElement $root): void
    {
        $spans = [];
        foreach ($root->getElementsByTagName('span') as $span) {
            if ($span->hasAttribute(self::KEEP_ATTR)) {
                $spans[] = $span;
            }
        }
        foreach ($spans as $span) {
            while ($span->firstChild !== null) {
                $span->parentNode?->insertBefore($span->firstChild, $span);
            }
            $span->parentNode?->removeChild($span);
        }
    }

    /**
     * Where the author name before a citation starts, as a CHARACTER offset
     * into $text, or null when there is nothing worth absorbing.
     */
    private function authorRunStart(string $text): ?int
    {
        if (trim($text) === '' && $text !== '') {
            return null; // just the space between two anchors
        }
        $length = mb_strlen($text);
        $from = max(0, $length - self::AUTHOR_RUN_MAX_CHARS);
        $tail = mb_substr($text, $from);

        // A surname, optionally behind initials ("C.L.R. James", "W. Arthur Lewis").
        $name = '(?:\p{Lu}\.\s*){0,4}\p{Lu}[\p{L}\x{2019}\'’\-]*';
        // An institutional author runs to two words ("Havana Congress",
        // "World Bank"); a personal one may be joined to a co-author.
        $org = "(?:{$name})(?:\\s+\\p{Lu}[\\p{L}\\x{2019}'’\\-]*)?";
        $joined = "(?:{$org})(?:\\s+(?:and|&)\\s+(?:{$name}))?(?:\\s+et\\s+al\\.?)?";

        // Parenthetical: everything after the bracket, provided it is only
        // author-ish tokens — "(UN 1974a)" absorbs UN, "(see also Smith" does not.
        if (preg_match('/[(\[]\s*('.$joined.')\s*$/u', $tail, $m, PREG_OFFSET_CAPTURE) === 1) {
            return $from + mb_strlen(substr($tail, 0, $m[1][1]));
        }
        // Narrative: the author opened the bracket the anchor sits inside —
        // "According to Prashad (2007)". The bracket is absorbed with it, so
        // the pair survives as "Prashad (2007)".
        // "([" and "( [" both occur, hence the repeated bracket group.
        if (preg_match('/(?<![\p{L}])('.$joined.')(?:\s*[(\[])+\s*$/u', $tail, $m, PREG_OFFSET_CAPTURE) === 1) {
            return $from + mb_strlen(substr($tail, 0, $m[1][1]));
        }
        // Bare narrative: a name immediately before the anchor, no bracket.
        if (preg_match('/(?<![\p{L}])('.$joined.')\s*$/u', $tail, $m, PREG_OFFSET_CAPTURE) === 1) {
            return $from + mb_strlen(substr($tail, 0, $m[1][1]));
        }

        return null;
    }

    private function isFurniture(\DOMElement $el): bool
    {
        if ($el->hasAttribute(self::KEEP_ATTR)) {
            return true;
        }
        foreach (self::KEPT_CLASSES as $class) {
            if (self::hasClass($el, $class)) {
                return true;
            }
        }

        if (self::tag($el) !== 'sup') {
            return false;
        }
        if ($el->hasAttribute('fn-count-id')) {
            return true;
        }
        foreach ($el->getElementsByTagName('*') as $descendant) {
            if (self::hasClass($descendant, 'footnote-ref')) {
                return true;
            }
        }

        return false;
    }

    /** @return array{0: string, 1: string, 2: string} leading space, core, trailing space */
    private static function splitEdges(string $text): array
    {
        preg_match('/^('.self::EDGE_SPACE.'*)(.*?)('.self::EDGE_SPACE.'*)$/su', $text, $m);

        return [$m[1] ?? '', $m[2] ?? $text, $m[3] ?? ''];
    }

    private static function stripPlaceholders(string $text): string
    {
        return preg_replace('/<\s*\/?\s*[gx]\d+\s*\/?\s*>/i', '', $text) ?? $text;
    }

    private static function tag(\DOMElement $el): string
    {
        return strtolower($el->tagName);
    }

    private static function hasClass(\DOMElement $el, string $class): bool
    {
        return in_array($class, preg_split('/\s+/', $el->getAttribute('class'), -1, PREG_SPLIT_NO_EMPTY) ?: [], true);
    }

    private static function isBlank(\DOMNode $node): bool
    {
        return $node instanceof \DOMText && trim($node->data, " \t\n\r\f") === '';
    }
}
