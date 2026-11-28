<?php

namespace App\Services\Conversion;

/**
 * Structural lint over a converted book's STORED nodes — "search a journal for problems".
 *
 * The maintainer loop used to be: read a book, notice a glitch, fix the converter, reconvert
 * everything, go back and read more books. That finds one bug per human read. Most conversion
 * defects, though, leave a SHAPE in the stored HTML that can be recognised without knowing the
 * source: a page-break fragment wrapped as a blockquote opens lower-case right after a
 * paragraph that never finished its sentence; a footnote the classifier missed sits in the body
 * as "7 Marx formulated…" while [^7] carries the same text; page chrome repeats verbatim across
 * the journal's articles. Each detector here is one such shape, taken from a real case, and
 * each finding carries the node and an excerpt so a human can confirm it in seconds.
 *
 * Deliberately offline and free: it reads nodes, never an LLM. It is a
 * TRIAGE ranking — a finding is "look here", not a verdict — and it is most useful as a
 * before/after DIFF around a corpus reconvert (`conversion:lint --save` / `--compare`), where
 * a detector count that moves is evidence about the change, whatever the absolute noise floor.
 *
 * Three things a finding can turn out to be, and the lint keeps them apart:
 *   a conversion defect       the default — scored, and what a converter fix is for
 *   the source's own doing    `cause: source` — the book's born-digital source prints it this
 *                             way (SourceWitness), or a person traced it there. Listed, counted
 *                             under `<detector>@source`, never scored.
 *   a false alarm             the detector misread ordinary text. A person dismisses it
 *                             (ConversionLintReport) and it leaves every count; a pattern of
 *                             them is a reason to teach the detector, as the exclusions below do.
 *
 * Detector vocabulary (stable keys — snapshots compare by them):
 *   fragment_blockquote  blockquote that opens lower-case after an unfinished sentence (7fa30289)
 *   split_sentence       paragraph that opens lower-case after an unfinished sentence
 *   body_footnote_twin   body paragraph "N text…" whose text IS footnote N (7fa30289 note 7)
 *   orphan_definition    a footnote definition no marker in the body points at
 *   orphan_unrecoverable …and whose marker the PDF's text layer does not carry either (the
 *                        converter's own verdict, footnote_meta.json `unlinked_definitions`)
 *   missing_definition   a footnote marker in the body with no definition
 *   raw_marker           unconverted [^N] / $^{N}$ / ^N left in body text
 *   glued_heading_digit  heading ending "Introduction1" with no marker — a lost footnote marker
 *   colon_heading        heading ending in ':' — usually a list lead-in promoted to a heading
 *   long_heading         sub-heading over 160 chars — usually a paragraph promoted to a heading
 *   chrome_leak          a short string repeated across the scope's books (page header/footer)
 *   wrong_note_link      a marker that opens a different note than the PDF prints for it
 *   marker_far_from_note a marker whose note the PDF prints on some other page
 *   marker_out_of_order  a marker numbered lower than the one before it
 *   lost_text            a run of a PDF page's text that is nowhere in the book
 *                        (these four are the converter's own checks against the PDF's text —
 *                        footnote_meta.json `integrity` — because no count can see them)
 */
class ConversionLint
{
    /**
     * Bump when a detector's behaviour changes: stored results (conversion_lint_results) carry
     * the version they were computed with and are recomputed when it moves.
     */
    public const VERSION = 12;

    /**
     * A finding's `cause`, when it is not the converter's doing: the source prints it this way.
     * Set by the lint itself where the book's own source witnesses it (SourceWitness), or by a
     * person (ConversionLintReport::VERDICT_SOURCE) where only a reader can tell — a marker the
     * source points at the wrong id, a stray character in a transcription. Such a finding is
     * still listed, for the record, and never scored.
     */
    public const CAUSE_SOURCE = 'source';
    public const SOURCE_SUFFIX = '@source';

    public const WEIGHTS = [
        'body_footnote_twin'  => 4,
        'fragment_blockquote' => 3,
        'split_sentence'      => 2,
        'orphan_definition'   => 2,
        // Reported, never scored: the PDF's own text carries no marker for the note either,
        // so there is nothing a converter fix could link it to.
        'orphan_unrecoverable' => 0,
        'missing_definition'  => 2,
        'raw_marker'          => 2,
        'note_keeps_marker'   => 2,
        'unconverted_note_link' => 2,
        'dead_internal_link'  => 1,
        'bare_superscript_number' => 1,
        'long_heading'        => 2,
        'glued_heading_digit' => 1,
        'colon_heading'       => 1,
        'chrome_leak'         => 1,
        // The two failures that matter most: a reader sent to the wrong note, and text gone.
        'wrong_note_link'     => 6,
        'lost_text'           => 4,
        'marker_far_from_note' => 3,
        'marker_out_of_order' => 1,
    ];

    /** A chrome candidate must recur in at least this many BOOKS of the scope… */
    public const CHROME_MIN_BOOKS = 3;
    /** …or this many times inside ONE book. */
    public const CHROME_MIN_IN_BOOK = 3;
    /**
     * Two books sharing this many candidates of at least SAME_TEXT_MIN_CHARS hold the same text.
     * Two, not five: a whole-issue PDF shares only a sentence or two with each article it
     * contains, and at five every such sentence read as page chrome (8d829795, twenty of them).
     * Real chrome that long carries a date or page range, is shared by far more than six books,
     * and is ignored here for exactly that reason.
     */
    public const SAME_TEXT_MIN_SHARED = 2;
    public const SAME_TEXT_MIN_CHARS = 40;

    /** Leading body nodes never read as page furniture: a prolific author's byline repeats across a journal. */
    private const FRONT_MATTER_NODES = 10;

    /**
     * A paragraph that opens with a list enumerator — "b) an abstraction from…", "(ii) …",
     * "c. …". Lower-case by design, and the item before it routinely ends on a comma, which is
     * exactly the split-sentence shape (27e44104's a)/b)/c)/d) list was four false alarms).
     */
    private const ENUMERATOR = '/^\\(?(?:[a-z]|[ivx]{1,5})[).]\\s/u';

    /**
     * A publication record an archive prints on each piece it holds: "Source: Marx Engels On
     * Literature and Art, Progress Publishers, 1976; Transcribed: by Andy Blunden;", "Scanned and
     * prepared for the Marxist Internet Archive by Paul Flewers." Repeated across a collection
     * because the same people prepared it — content, not a page header.
     */
    private const PROVENANCE_LINE = '/^(?:source|written|first published|published|translated|transcribed|transcription|scanned|proofed|proofread|markup|html markup|online version|public domain|copyleft|digitali[sz]ed|prepared)\b[^.]{0,3}(?::|\s+(?:and|by|for|from|in)\b)/iu';

    private const TERMINAL = '/[.!?:;)\]"”’\'…]$/u';
    private const PROSE_TAGS = ['p', 'blockquote', 'ul', 'ol'];
    private const SKIPPABLE_TAGS = ['img', 'figure', 'a', 'hr', 'table'];

    /**
     * @param array<int, array{startLine: string, content: string}> $nodes in reading order
     * @param array<string, string>|null $footnotes footnoteId => content (the `footnotes` table —
     *        what the reader actually resolves a marker against; the def nodes in the body do
     *        not all carry an anchor, so they are only used when this is null)
     * @return array{findings: list<array{detector: string, startLine: string, excerpt: string, near?: true}>,
     *               chrome_candidates: list<string>}
     */
    public function lintBook(array $nodes, ?array $footnotes = null, array $evidence = []): array
    {
        // What the converter learned from the PDF itself (see evidenceFor()): absent for a
        // book with no PDF, and then every finding stands.
        $unlinkedVerdicts = $evidence['unlinked'] ?? [];
        $headingLines = $evidence['heading_lines'] ?? [];
        $quoteBlocks = $evidence['quote_blocks'] ?? [];
        // What a born-digital source says about its own structure (SourceWitness): null for a
        // PDF, and then nothing is ever attributed to the source.
        $source = $evidence['source'] ?? null;
        $body = [];
        $defs = [];           // fn id => definition text
        $defLines = [];       // fn id => startLine of its stored definition node, where one has an anchor
        $defNodes = [];       // startLine => text of every node in the stored definitions section
        $anchorIds = [];      // every id / name any node's content carries: what an in-page link can land on
        $headingAnchorIds = []; // …and those of them a HEADING carries: where a contents entry lands
        $inDefs = false;
        foreach ($nodes as $n) {
            $html = (string) ($n['content'] ?? '');
            $idm = [];
            if (preg_match_all('/<[^>]*\s(?:id|name)="([^"]+)"/', $html, $idm)) {
                $anchorIds += array_flip($idm[1]);
            }
            $tag = $this->tag($html);
            if (preg_match('/^h[1-6]$/', $tag) && !empty($idm[1])) {
                $headingAnchorIds += array_flip($idm[1]);
            }
            if (preg_match('/^h[1-6]$/', $tag)) {
                // The definitions section ends at the next heading. A converter slip can put the
                // "Footnotes" heading mid-article (9d0400c9), and treating everything after it
                // as definitions hid every later marker — 37 linked notes read as orphaned.
                $inDefs = (bool) preg_match('/>\s*(?:foot|end)?notes\s*</i', $html);
                if ($inDefs) {
                    continue;
                }
            }
            // …and it ends at the first paragraph that is plainly BODY: one carrying a marker
            // and no definition anchor. A section's notes can sit mid-article with no heading
            // after them (f04989d6 — six notes, then the article carries on), and reading the
            // rest as definitions hid thirteen correctly linked markers.
            if ($inDefs && !preg_match('/^<p[^>]*>\s*<a fn-count-id=/', $html)
                    && str_contains($html, '<sup class="footnote-ref"')) {
                $inDefs = false;
            }
            if ($inDefs || preg_match('/^<p[^>]*>\s*<a fn-count-id=/', $html)) {
                if (preg_match('/<a fn-count-id="[^"]*" id="([^"]+)"/', $html, $m)) {
                    $defs[$m[1]] = preg_replace('/^\[\^\d+\]:\s*/', '', $this->text($html));
                    $defLines[$m[1]] = (string) $n['startLine'];
                }
                $defNodes[(string) $n['startLine']] = preg_replace('/^\[\^\d+\]:\s*/', '', $this->text($html));
                continue;
            }
            $body[] = ['startLine' => (string) $n['startLine'], 'html' => $html, 'tag' => $tag,
                       'text' => $this->text($html)];
        }

        if ($footnotes !== null) {
            $defs = array_map(fn ($c) => $this->text((string) $c), $footnotes);
        }

        $findings = [];
        $add = function (string $detector, array $node, ?string $excerpt = null, ?string $cause = null) use (&$findings) {
            $finding = ['detector' => $detector, 'startLine' => $node['startLine'],
                        'excerpt' => mb_substr($excerpt ?? $node['text'], 0, 220)];
            if ($cause !== null) {
                $finding['cause'] = $cause;
            }
            $findings[] = $finding;
        };
        // The source marks these very words as a heading: whatever it looks like, nothing was
        // promoted. Marx's analytical headings run to five hundred characters (the Grundrisse —
        // 48 "very long headings", every one his).
        $sourceHeading = fn (string $headText): bool => $source !== null
            && $this->opensOneOf($headText, $source['headings'] ?? [], 60);

        // How many headings share each two-word opening ("discussion turn" → 10).
        $headingSeries = [];
        foreach ($body as $node) {
            if (preg_match('/^h[2-6]$/', $node['tag'])) {
                $key = $this->seriesKey($node['text']);
                if ($key !== '') {
                    $headingSeries[$key] = ($headingSeries[$key] ?? 0) + 1;
                }
            }
        }

        $inRefs = false;
        $markerIds = [];
        foreach ($body as $i => $node) {
            $tag = $node['tag'];
            $text = $node['text'];

            if (preg_match('/^h[1-6]$/', $tag)) {
                $inRefs = (bool) preg_match('/^\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited|literatur(?:e|verzeichnis)?|quellen(?:verzeichnis)?|r[ée]f[ée]rences|bibliographie|referencias|bibliograf[íi]a)\b/iu', $text);
                $bare = preg_replace('/<sup class="footnote-ref".*?<\/sup>/s', '', $node['html']);
                $headText = trim(html_entity_decode(strip_tags($bare), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
                if (preg_match('/\p{Ll}{3,}\d{1,2}$/u', $headText)) {
                    $add('glued_heading_digit', $node, $headText);
                }
                // …unless the PDF sets these very words in a heading type style: then the colon is
                // the author's, the heading is real, and there is nothing to repair (db2d8fb7
                // prints thirty "Beauty as a principle of society:" sub-headings in bold).
                if (str_ends_with($headText, ':') && !$sourceHeading($headText)
                        && !preg_match('/^(?:\d+\.?\s*)?(?:references|bibliography|keywords?|abstract|notes)\s*:$/i', $headText)
                        && !$this->opensOneOf(preg_replace('/^\d{1,2}(?:\.\d{1,2})*\.?\s*/', '', $headText), $headingLines, 60)) {
                    $add('colon_heading', $node, $headText);
                }
                // Not the h1: an article's own title is legitimately a sentence ("The Diamond Model of
                // Open Access Publishing: Why Policy Makers, Scholars, …" is 190 characters).
                // …nor a heading that carries its own section number: a paragraph promoted to a
                // heading has none, and "4.3. Are People who Argue for an Alternative Concept of
                // Work Stalinist Labour Fetishists? Why We Need to Repeat…" is the printed title.
                // …nor one of a SERIES: "Discussion Turn 6 (Christian Fuchs): …" beside nine other
                // "Discussion Turn N" headings is the article's own structure (2b51bc20).
                if ($tag !== 'h1' && mb_strlen($headText) > 160 && !$sourceHeading($headText)
                        && !preg_match('/^\d{1,2}(?:\.\d{1,2}){1,3}\.?\s/', $headText)
                        && ($headingSeries[$this->seriesKey($headText)] ?? 0) < 3) {
                    $add('long_heading', $node, $headText);
                }
            }

            if (preg_match_all('/<sup class="footnote-ref"[^>]*\bid="([^"]+)"/', $node['html'], $mm)) {
                foreach ($mm[1] as $id) {
                    $markerIds[$id] = $node;
                }
            }

            if (preg_match('/\[\^\d{1,3}\]|\$\^\{?\d{1,3}\}?\$/', $text)) {
                $add('raw_marker', $node);
            }

            // A printed note that still carries the source's own marker after ours:
            // "[****] **** In the manuscript: …" (marx-1863-theories-of-surplus-value, 2026-11-25 —
            // a run of four stars was not recognised as the note's marker). A symbol repeated is
            // always this; a number or letter repeated only when it is still a link, because
            // "[1] 1 January 1917 …" is ordinary prose.
            if ($tag === 'p' && preg_match('/^\[([^\]\s]{1,6})\]\s+(\S{1,6})\s/u', $text, $m)
                    && ($m[2] === $m[1] || (preg_match('/^[*†‡§¶#+]{2,}$/u', $m[2]) && preg_match('/^[*†‡§¶#+]+$/u', $m[1])))
                    && (preg_match('/^[*†‡§¶#+]+$/u', $m[2]) || preg_match('/^<p[^>]*>\s*\[[^\]]+\]\s*<a\b/u', $node['html']))) {
                $add('note_keeps_marker', $node);
            }

            // A note marker the converter did not recognise is still there as what the source
            // made it: an in-page link whose whole text is a marker ("[*1]", "**", "a"), or a bare
            // superscript number. Sources mark notes in more ways than any list of patterns holds
            // (marxists.org alone: sup.enote, span.note, bare links, starred series), so this reads
            // the LEFTOVER instead of the pattern — whatever shape was missed, it ends up as one
            // of these two. (the-poverty-of-philosophy "[*1]", prod 2026-11-25.)
            // An ordinary in-page link (a contents entry, "see Chapter 3") whose landing spot is
            // in no node of the book. The source's anchor was lost on the way in: marxists.org
            // prints section anchors BETWEEN blocks, and a book is stored one node per block
            // (the Grundrisse's analytical contents lost 34 of 297 links). Marker-shaped links
            // are the detector below's; a citation or hypercite lands outside the nodes by design.
            if (preg_match_all('/<a\b([^>]*)\bhref="#([^"]+)"([^>]*)>(.*?)<\/a>/su', $node['html'], $dm, PREG_SET_ORDER)) {
                foreach ($dm as $d) {
                    $attrs = $d[1] . $d[3];
                    $label = trim(html_entity_decode(strip_tags($d[4]), ENT_QUOTES | ENT_HTML5));
                    if (isset($anchorIds[$d[2]]) || isset($anchorIds[rawurldecode($d[2])])
                            || str_contains($attrs, 'citation') || str_contains($attrs, 'hypercite')
                            || preg_match('/^(?:Fn|hypercite_|HL_)/', $d[2])
                            // "#turney2017": an author-year citation key. A citation with no
                            // bibliography entry is a different defect, and not this detector's.
                            || preg_match('/^[\p{L}_-]+\d{4}[a-z]?$/u', $d[2])
                            || preg_match('/^[\[(]?(?:\d{1,3}[a-z]?|[*†‡§¶#+]{1,6}\d{0,3}|[a-z])[\])]?\.?$/iu', $label)) {
                        continue;
                    }
                    $add('dead_internal_link', $node, "link “" . mb_substr($label, 0, 60) . "” → #{$d[2]}");
                    break;
                }
            }

            if (preg_match_all('/<a\b([^>]*)\bhref="#[^"]*"([^>]*)>(.*?)<\/a>/su', $node['html'], $am, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
                foreach ($am as $a) {
                    $attrs = $a[1][0] . $a[2][0];
                    $label = trim(html_entity_decode(strip_tags($a[3][0]), ENT_QUOTES | ENT_HTML5));
                    // A marker FOLLOWS the words it annotates. A numbered link that opens its
                    // block is a contents entry ("1 Transfer of the Inquiry…" — 170 of them in
                    // one table of contents) or the definition side of a pair.
                    $before = trim(strip_tags(substr($node['html'], 0, $a[0][1])));
                    if ($before === '' || preg_match('/^\[[^\]]{1,6}\]$/u', $before)) {   // …or our own "[N]" label
                        continue;
                    }
                    // "…<br/>2. Measures for the Middle Classes": a bare number with its own full
                    // stop and a title after it is a line of a contents list, wherever it stands
                    // in the block (The Civil War in France — 26 such links to section headings).
                    // …and so is any numbered link that lands ON a heading, however the line is
                    // punctuated: "5 Opening of the Civil War" has no bracket after its number
                    // (The Civil War in France, second draft — 8 of these). A note is never a heading.
                    if (preg_match('/\bhref="#([^"]+)"/', $a[0][0], $hm)
                            && (isset($headingAnchorIds[$hm[1]]) || isset($headingAnchorIds[rawurldecode($hm[1])]))) {
                        continue;
                    }
                    $after = substr($node['html'], $a[0][1] + strlen($a[0][0]), 12);
                    if (preg_match('/^\d{1,3}$/', $label) && preg_match('/^[.)]\s+\p{Lu}/u', $after)) {
                        continue;
                    }
                    if (!str_contains($attrs, 'citation') && !str_contains($attrs, 'hypercite')
                            && preg_match('/^[\[(]?(?:\d{1,3}[a-z]?|[*†‡§¶#+]{1,6}\d{0,3}|[a-z])[\])]?\.?$/iu', $label)) {
                        $add('unconverted_note_link', $node, "link “{$label}” · " . mb_substr($text, 0, 170));
                        break;
                    }
                }
            }
            // A number raised after a word or closing punctuation, with no fraction or subscript
            // after it: "…accounts of profit.²⁹ This something…". Fractions (¹⁄₃), exponents and
            // indexed symbols (K¹—K¹⁸) are the same tag and are left alone.
            // Not in the front matter where the number keys an AFFILIATION: the converter turns
            // "Gallant¹ & Boone²" over "¹Linda_Gallant@…" into plain superscripts on purpose,
            // and the byline and its affiliation lines are exactly that shape.
            if ($i < self::FRONT_MATTER_NODES && preg_match('/^\s*(?:<[^>]+>\s*)*<sup>\d{1,2}<\/sup>/u', $node['html'])) {
                // the affiliation line itself opens on its number
            } elseif ($i < self::FRONT_MATTER_NODES && isset($body[$i + 1])
                    && preg_match('/^\s*(?:<[^>]+>\s*)*<sup>\d{1,2}<\/sup>/u', $body[$i + 1]['html'])) {
                // the byline: the very next node opens on an affiliation number
            } elseif (preg_match('/(?:\p{Ll}{3}|[.,;:!?”’"\)])<sup>(\d{1,3})<\/sup>(?!\s*(?:[\/⁄]|<sub>|&frasl;))/u', $node['html'], $sm, PREG_OFFSET_CAPTURE)) {
                // The source prints the number raised and unlinked itself: there was never a
                // link to convert (Theories of Surplus-Value, "…accounts of profit.²⁹").
                $at = $sm[1][1] - strlen('<sup>');
                $inSource = $source !== null && isset($source['bare_sups'][
                    SourceWitness::supKey(substr($node['html'], max(0, $at - 400), min(400, $at)), $sm[1][0])]);
                $add('bare_superscript_number', $node, null, $inSource ? self::CAUSE_SOURCE : null);
            }

            if ($inRefs || str_contains($node['html'], 'class="bib-entry"')) {
                continue;     // bibliography entries split differently; not this lint's business
            }

            // A footnote's OCR copy left in the body: "7 Marx formulated…" == def of [^7].
            if ($tag === 'p' && preg_match('/^(\d{1,3})\s+(\S.{30,})/su', $text, $m)) {
                $head = $this->norm($m[2], 40);
                foreach ($defs as $defText) {
                    if (mb_strlen($head) >= 30 && $this->norm($defText, 40) === $head) {
                        $add('body_footnote_twin', $node);
                        break;
                    }
                }
            }

            // Opens lower-case after a sentence that never finished: a page-break split.
            if (in_array($tag, ['p', 'blockquote'], true) && preg_match('/^\p{Ll}/u', $text)) {
                $prev = $this->previousProse($body, $i);
                if ($prev !== null && $this->leavesSentenceOpen($prev['text'])
                        && mb_strlen($text) >= 40 && !preg_match('#^(?:https?:|www\.)#i', $text)
                        && !preg_match(self::ENUMERATOR, $text)
                        && !$this->isLetteredLegendRow($body, $i)
                        // A display the sentence runs THROUGH: "…such that the diagram of the
                        // form ⏎ [image] ⏎ is a pullback." (df532d32). A figure with a caption
                        // is a float and still counts.
                        && !$this->runsThroughDisplay($body, $i)
                        // A quotation that completes its lead-in sentence ("…defines fascism
                        // as ⏎ a genus of political ideology…") has this exact shape and is
                        // not a fragment: the PDF indents it as a block (bd7c450b, five of them).
                        && !($tag === 'blockquote' && $this->opensOneOf($text, $quoteBlocks, 30))
                        // …and where no indentation record covers it, the citation does: the
                        // lead-in names its source ("Griffin (1993, 44) defines fascism as"), or
                        // the block closes on one ("… (Agamben 2000, 31)"). A page-break fragment
                        // carries neither (90556e72, 45e713ca).
                        && !($tag === 'blockquote' && $this->isCitedQuotation($prev['text'], $text))) {
                    // The source itself starts a new block here — a display quotation set inside
                    // its sentence, a manuscript page break transcribed as a paragraph break.
                    // The converter carried the source over; there is no join for it to have made.
                    $inSource = $source !== null
                        && isset($source['blocks'][SourceWitness::opening(preg_replace('/^\s*<[^>]+>/', '', $node['html']) ?? '')]);
                    $add($tag === 'blockquote' ? 'fragment_blockquote' : 'split_sentence', $node,
                        '…' . mb_substr($prev['text'], -70) . ' ‖ ' . mb_substr($text, 0, 120),
                        $inSource ? self::CAUSE_SOURCE : null);
                }
            }
        }

        foreach ($defs as $id => $defText) {
            if (!isset($markerIds[$id])) {
                $head = self::verdictHead($defText);
                $unrecoverable = $head !== '' && ($unlinkedVerdicts[$head] ?? null) === 'no_marker_in_layer';
                $finding = ['detector' => $unrecoverable ? 'orphan_unrecoverable' : 'orphan_definition',
                            'startLine' => $defLines[$id] ?? $this->defNodeByText($defText, $defNodes),
                            'excerpt' => mb_substr($defText, 0, 220)];
                // No stored definition node to land on — the HTML/EPUB lanes (marxists.org among
                // them) keep notes ONLY in the footnotes table. Land where the lost marker belongs
                // instead: beside its nearest linked neighbour in note order.
                if ($finding['startLine'] === '' && ($near = $this->nearestLinkedMarker((string) $id, array_keys($defs), $markerIds)) !== null) {
                    $finding['startLine'] = $near;
                    $finding['near'] = true;
                }
                $findings[] = $finding;
            }
        }
        foreach ($markerIds as $id => $node) {
            if (!isset($defs[$id]) && $defs !== []) {
                $add('missing_definition', $node);
            }
        }
        // The same slip seen from the popup: the definition itself opens with a run of symbols.
        // Two or more only — a lone "*" can open a note legitimately ("* p < 0.05").
        foreach ($defs as $id => $defText) {
            if (isset($markerIds[$id]) && preg_match('/^[*†‡§¶#+]{2,}\s/u', ltrim($defText))) {
                $add('note_keeps_marker', $markerIds[$id], 'footnote opens with its own marker: ' . mb_substr(ltrim($defText), 0, 160));
            }
        }

        foreach ($this->integrityFindings($evidence['integrity'] ?? [], $body) as $finding) {
            $findings[] = $finding;
        }

        return ['findings' => $findings, 'chrome_candidates' => $this->chromeCandidates($body, $defs)];
    }

    /**
     * The converter's own checks against the PDF's text, as findings. Each lands on the body
     * node that holds the words the converter recorded beside it (before the marker, or before
     * the gap); where those words cannot be found it lands on the first node, still listed.
     *
     * @param array<string, mixed> $integrity footnote_meta.json `integrity`
     * @param list<array{startLine: string, text: string}> $body
     * @return list<array{detector: string, startLine: string, excerpt: string}>
     */
    private function integrityFindings(array $integrity, array $body): array
    {
        if ($body === []) {
            return [];
        }
        $folded = null;
        $locate = function (string $words) use ($body, &$folded): string {
            $folded ??= array_map(fn ($n) => self::fold($n['text']), $body);
            $needle = substr(self::fold($words), -30);
            if (strlen($needle) >= 12) {
                foreach ($folded as $i => $text) {
                    if (str_contains($text, $needle)) {
                        return $body[$i]['startLine'];
                    }
                }
            }

            return $body[0]['startLine'];
        };
        $out = [];
        foreach ((array) ($integrity['wrong_note'] ?? []) as $r) {
            $out[] = ['detector' => 'wrong_note_link', 'startLine' => $locate((string) ($r['context'] ?? '')),
                'excerpt' => mb_substr(sprintf('…%s [the PDF prints %s here; it opens the note printed as %s] %s',
                    mb_substr((string) ($r['context'] ?? ''), -70), $r['marker_printed'] ?? '?',
                    $r['note_printed'] ?? '?', (string) ($r['note'] ?? '')), 0, 220)];
        }
        foreach ((array) ($integrity['far_from_note'] ?? []) as $r) {
            $out[] = ['detector' => 'marker_far_from_note', 'startLine' => $locate((string) ($r['context'] ?? '')),
                'excerpt' => mb_substr(sprintf('…%s [marker on PDF page %d, its note on page %d] %s',
                    mb_substr((string) ($r['context'] ?? ''), -70), (int) ($r['marker_page'] ?? 0) + 1,
                    (int) ($r['note_page'] ?? 0) + 1, (string) ($r['note'] ?? '')), 0, 220)];
        }
        foreach ((array) ($integrity['out_of_order'] ?? []) as $r) {
            $out[] = ['detector' => 'marker_out_of_order', 'startLine' => $locate((string) ($r['context'] ?? '')),
                'excerpt' => mb_substr(sprintf('…%s [marker %s comes after marker %s]',
                    mb_substr((string) ($r['context'] ?? ''), -90), $r['number'] ?? '?', $r['after'] ?? '?'), 0, 220)];
        }
        foreach ((array) ($integrity['lost_text'] ?? []) as $r) {
            $out[] = ['detector' => 'lost_text', 'startLine' => $locate((string) ($r['before'] ?? '')),
                'excerpt' => mb_substr(sprintf('PDF page %d, not in the book: %s',
                    (int) ($r['page'] ?? 0) + 1, (string) ($r['excerpt'] ?? '')), 0, 220)];
        }

        return $out;
    }

    /**
     * True when `$text`, folded to bare letters and digits, opens with — or is the opening of —
     * one of the folded strings the converter recorded from the PDF's layout.
     *
     * @param list<string> $recorded already folded
     */
    /**
     * A block quotation in a citation frame: the unfinished lead-in sentence carries a
     * year-parenthetical, or the block itself ends on a parenthetical reference.
     */
    private function isCitedQuotation(string $leadIn, string $quote): bool
    {
        $tail = mb_substr(trim($leadIn), -200);
        if (preg_match('/\((?:[^()]{0,40})?\b(?:1[5-9]|20)\d{2}[a-z]?\b[^()]{0,25}\)[^.!?]{0,80}$/u', $tail)) {
            return true;
        }

        return (bool) preg_match('/\([^()]{0,80}\d{1,4}\)\s*[.”"’\']?\s*(?:\[\^?\d+\])?\s*$/u', trim($quote));
    }

    /** The first two words of a heading, folded — the key headings of one series share. */
    private function seriesKey(string $heading): string
    {
        if (! preg_match('/^\s*(\p{L}{3,})\s+(\p{L}{3,})\b/u', $heading, $m)) {
            return '';
        }

        return mb_strtolower($m[1].' '.$m[2]);
    }

    private function opensOneOf(string $text, array $recorded, int $chars): bool
    {
        $want = substr(self::fold($text), 0, $chars);
        if (strlen($want) < 8) {
            return false;
        }
        foreach ($recorded as $have) {
            if (str_starts_with($have, $want) || (strlen($have) >= 8 && str_starts_with($want, $have))) {
                return true;
            }
        }

        return false;
    }

    private static function fold(string $text): string
    {
        return preg_replace('/[^a-z0-9]+/', '', mb_strtolower($text)) ?? '';
    }

    /**
     * A table legend keyed by bare letters — "a Provides a discussion using Marx's ideas",
     * "b The whole article is dedicated to…" (294c2019, nine false split sentences). A bare
     * letter proves nothing alone ("a Marxist analysis…" opens a real fragment), so a NEIGHBOUR
     * must carry the adjacent letter.
     */
    private function isLetteredLegendRow(array $body, int $i): bool
    {
        if (!preg_match('/^([a-z])\s+\p{Lu}/u', $body[$i]['text'], $m)) {
            return false;
        }
        $letter = ord($m[1]);
        foreach ([[$i - 1, $letter - 1], [$i + 1, $letter + 1]] as [$j, $want]) {
            if (isset($body[$j]) && preg_match('/^' . chr($want) . '\s+\p{Lu}/u', $body[$j]['text'])) {
                return true;
            }
        }

        return false;
    }

    /**
     * Where an orphaned definition sits when its stored node carries no anchor to find it by
     * (most stored definitions are bare "[^N]: text" paragraphs): the definitions-section node
     * that opens with the same words. '' when none does — the finding then has nowhere to jump.
     *
     * @param array<string, string> $defNodes startLine => text
     */
    private function defNodeByText(string $defText, array $defNodes): string
    {
        $norm = fn (string $t) => mb_substr(mb_strtolower(preg_replace('/\s+/u', '', $t)), 0, 40);
        $want = $norm($defText);
        if ($want === '') {
            return '';
        }
        foreach ($defNodes as $line => $text) {
            if ($norm($text) === $want) {
                return (string) $line;
            }
        }

        return '';
    }

    /**
     * The node carrying the marker of the linked note nearest BEFORE `$id` in document order
     * (else the nearest after it) — where an orphan's lost marker would have stood. Footnote ids
     * are minted in document order (`shared/fnids.py`: `Fn<epoch-ms>_<fixed-width base36
     * counter>`), so a plain string sort of ids sharing one prefix is reading order. Ids of a
     * different shape (another prefix, or no `Fn<digits>_` at all) say nothing about order: null.
     *
     * @param list<string|int> $defIds
     * @param array<string, array{startLine: string}> $markerIds
     */
    private function nearestLinkedMarker(string $id, array $defIds, array $markerIds): ?string
    {
        $shape = '/^(.*?)Fn\d+_[0-9a-z]+$/';
        if (!preg_match($shape, $id, $m)) {
            return null;
        }
        $ordered = array_values(array_filter(array_map('strval', $defIds),
            fn (string $d) => preg_match($shape, $d, $dm) && $dm[1] === $m[1]));
        sort($ordered, SORT_STRING);
        $at = array_search($id, $ordered, true);
        if ($at === false) {
            return null;
        }
        for ($i = $at - 1; $i >= 0; $i--) {
            if (isset($markerIds[$ordered[$i]])) {
                return $markerIds[$ordered[$i]]['startLine'];
            }
        }
        for ($i = $at + 1, $n = count($ordered); $i < $n; $i++) {
            if (isset($markerIds[$ordered[$i]])) {
                return $markerIds[$ordered[$i]]['startLine'];
            }
        }

        return null;
    }

    /**
     * Chrome findings across a scope. A page header/footer the OCR glued into text is the same
     * short string in every article of a journal ("© Vienna University of Technology 2003." on
     * every footnote of 7fa30289's issue) — invisible in one book, obvious across ten.
     *
     * @param array<string, list<string>> $candidatesByBook
     * @return array<string, list<string>> book => leaked strings
     */
    public function chromeLeaks(array $candidatesByBook): array
    {
        return $this->chromeLeaksFromCounts(array_map('array_count_values', $candidatesByBook));
    }

    /**
     * The same verdict from pre-counted candidates (string => occurrences per book) — the shape
     * conversion_lint_results stores, so a journal's leaks can be decided without re-linting.
     *
     * @param array<string, array<string, int>> $countsByBook
     * @return array<string, list<string>> book => leaked strings
     */
    public function chromeLeaksFromCounts(array $countsByBook): array
    {
        $books = [];
        foreach ($countsByBook as $book => $counts) {
            foreach ($counts as $c => $n) {
                $books[$c][$book] = $n;
            }
        }
        $copyOf = $this->sameTextClusters($books);
        $out = [];
        foreach ($books as $c => $perBook) {
            $distinct = [];
            foreach ($perBook as $book => $_n) {
                $distinct[$copyOf[$book] ?? $book] = true;
            }
            $multiBook = count($distinct) >= self::CHROME_MIN_BOOKS;
            foreach ($perBook as $book => $n) {
                if ($multiBook || $n >= self::CHROME_MIN_IN_BOOK) {
                    $out[$book][] = $c;
                }
            }
        }
        return $out;
    }

    /**
     * Books that are copies of ONE text — the same article held in two lanes, or an issue
     * and the article cut from it. They share whole sentences, and every shared sentence then
     * "recurs across the journal" and reads as page furniture (8d829795 / 161d0385: ninety
     * ordinary sentences each). Two books sharing this many LONG candidates are one text, and
     * count once towards CHROME_MIN_BOOKS; real chrome is short and shared by everything.
     *
     * @param array<string, array<string, int>> $books candidate => book => occurrences
     * @return array<string, string> book => representative book of its cluster
     */
    private function sameTextClusters(array $books): array
    {
        $shared = [];
        foreach ($books as $c => $perBook) {
            if (mb_strlen((string) $c) < self::SAME_TEXT_MIN_CHARS || count($perBook) < 2 || count($perBook) > 6) {
                continue;
            }
            $ids = array_map('strval', array_keys($perBook));
            sort($ids);
            for ($i = 0; $i < count($ids); $i++) {
                for ($j = $i + 1; $j < count($ids); $j++) {
                    $shared[$ids[$i]][$ids[$j]] = ($shared[$ids[$i]][$ids[$j]] ?? 0) + 1;
                }
            }
        }
        $parent = [];
        $find = function (string $b) use (&$parent, &$find): string {
            $parent[$b] ??= $b;
            return $parent[$b] === $b ? $b : ($parent[$b] = $find($parent[$b]));
        };
        foreach ($shared as $a => $others) {
            foreach ($others as $b => $n) {
                if ($n >= self::SAME_TEXT_MIN_SHARED) {
                    $parent[$find((string) $b)] = $find((string) $a);
                }
            }
        }
        $out = [];
        foreach (array_keys($parent) as $b) {
            $out[(string) $b] = $find((string) $b);
        }

        return $out;
    }

    /** The key the converter files a definition's verdict under: its opening, folded. */
    public static function verdictHead(string $defText): string
    {
        return substr(preg_replace('/[^a-z0-9]+/', '', mb_strtolower($defText)) ?? '', 0, 40);
    }

    /**
     * What the conversion recorded from the PDF itself, for lintBook():
     *   unlinked      head => verdict for each definition the converter could not link
     *                 (footnote_meta.json `unlinked_definitions`)
     *   heading_lines folded text of every line set in a heading type style (heading_geometry.json)
     *   quote_blocks  folded opening of every block the page indents (quote_geometry.json)
     *   integrity     the converter's checks of markers and page text against the PDF
     *                 (footnote_meta.json `integrity`)
     * Each is empty for a book converted before it existed, or by a lane with no PDF — the
     * finding it would have qualified then stands, which is the safe default.
     *
     *   source        what a born-digital source says of its own blocks, headings and raised
     *                 numbers (SourceWitness) — null for a PDF
     *
     * @return array{unlinked: array<string, string>, heading_lines: list<string>, quote_blocks: list<string>, source: ?array}
     */
    public static function evidenceFor(string $book): array
    {
        $read = function (string $file) use ($book) {
            $path = resource_path("markdown/{$book}/{$file}");

            return is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        };
        $out = ['unlinked' => [], 'heading_lines' => [], 'quote_blocks' => [], 'integrity' => [],
                'source' => SourceWitness::for($book)];
        $meta = $read('footnote_meta.json') ?? [];
        if (is_array($meta['integrity'] ?? null)) {
            $out['integrity'] = $meta['integrity'];
        }
        foreach (($meta['unlinked_definitions'] ?? []) as $row) {
            if (is_array($row) && ($row['head'] ?? '') !== '' && isset($row['verdict'])) {
                $out['unlinked'][(string) $row['head']] = (string) $row['verdict'];
            }
        }
        foreach ((($read('heading_geometry.json') ?? [])['lines'] ?? []) as $line) {
            $folded = self::fold(preg_replace('/^\d{1,2}(?:\.\d{1,2})*\.?\s*/', '', (string) ($line['text'] ?? '')));
            if (strlen($folded) >= 8) {
                $out['heading_lines'][] = $folded;
            }
        }
        foreach (($read('quote_geometry.json') ?? []) as $pageBlocks) {
            foreach ((array) $pageBlocks as $block) {
                // Line-break hyphens ("socie- tal") fold away with the rest of the punctuation.
                $folded = self::fold(is_string($block) ? $block : '');
                if (strlen($folded) >= 8) {
                    $out['quote_blocks'][] = substr($folded, 0, 60);
                }
            }
        }

        return $out;
    }

    /** Weighted score for one book's findings (used for ranking, never as a verdict). */
    public static function score(array $counts): int
    {
        $s = 0;
        foreach ($counts as $d => $n) {
            if (str_ends_with((string) $d, self::SOURCE_SUFFIX)) {
                continue;     // listed, never scored: not something a converter fix can change
            }
            $s += (self::WEIGHTS[$d] ?? 1) * $n;
        }
        return $s;
    }

    /**
     * Findings counted per detector, with the ones attributed to the source under their own
     * key (`split_sentence@source`) so a total never mixes "ours to fix" with "theirs".
     *
     * @param list<array{detector: string, cause?: string}> $findings
     * @return array<string, int>
     */
    public static function counts(array $findings): array
    {
        return array_count_values(array_map(
            fn (array $f) => $f['detector'] . (($f['cause'] ?? null) === self::CAUSE_SOURCE ? self::SOURCE_SUFFIX : ''),
            $findings,
        ));
    }

    /** A finding's identity across a reconvert: node ids change, the excerpt does not. */
    public static function key(array $finding): string
    {
        return $finding['detector'] . ':' . substr(sha1(
            preg_replace('/\s+/', ' ', mb_strtolower($finding['excerpt']))), 0, 12);
    }

    /**
     * Before/after over two sets of books, each `book => ['counts' => [...], 'keys' => [...]]`.
     * Only books present on BOTH sides are compared — a book that has no content right now (still
     * queued behind a reconvert) or that joined the scope later says nothing about the change.
     *
     * @return array{detectors: array<string, array{0:int,1:int}>, gone: int, new: array<string, list<string>>, compared: int}
     */
    public static function compare(array $before, array $now): array
    {
        $detectors = [];
        $new = [];
        $gone = 0;
        $compared = 0;
        foreach ($now as $book => $b) {
            if (!isset($before[$book])) {
                continue;
            }
            $compared++;
            foreach ($before[$book]['counts'] ?? [] as $d => $n) {
                $detectors[$d][0] = ($detectors[$d][0] ?? 0) + $n;
                $detectors[$d][1] ??= 0;
            }
            foreach ($b['counts'] ?? [] as $d => $n) {
                $detectors[$d][0] ??= 0;
                $detectors[$d][1] = ($detectors[$d][1] ?? 0) + $n;
            }
            $was = $before[$book]['keys'] ?? [];
            $gone += count(array_diff($was, $b['keys'] ?? []));
            $fresh = array_values(array_diff($b['keys'] ?? [], $was));
            if ($fresh) {
                $new[$book] = $fresh;
            }
        }
        ksort($detectors);
        return ['detectors' => $detectors, 'gone' => $gone, 'new' => $new, 'compared' => $compared];
    }

    private function chromeCandidates(array $body, array $defs): array
    {
        $out = [];
        $texts = array_values($defs);
        $inRefs = false;
        foreach ($body as $i => $n) {
            if ($i < self::FRONT_MATTER_NODES) {
                continue;     // byline / affiliation / "Abstract" — the same across one author's articles by design
            }
            if (preg_match('/^h[1-6]$/', $n['tag'])) {
                $inRefs = (bool) preg_match('/^\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited|literatur(?:e|verzeichnis)?|quellen(?:verzeichnis)?|r[ée]f[ée]rences|bibliographie|referencias|bibliograf[íi]a)\b/iu', $n['text']);
                continue;     // headings repeat by design ("Conclusion", "About the Authors")
            }
            if ($inRefs || str_contains($n['html'], 'class="bib-entry"')) {
                continue;     // "London: Verso." ends half of every bibliography
            }
            $texts[] = $n['text'];
        }
        foreach ($texts as $t) {
            $t = trim($t);
            if ($t === '' || preg_match(self::PROVENANCE_LINE, $t)) {
                continue;     // the archive's record of the text — and its tail ("…, Stuttgart, 1913.") with it
            }
            // The whole node when it is short (a running head as its own paragraph), else the
            // trailing segment after the last sentence boundary (a footer glued onto a note).
            $cands = [];
            if (mb_strlen($t) <= 100 && !preg_match('/[.!?]\s+\S/u', $t)) {
                $cands[] = $t;
            }
            if (preg_match('/[.!?]\s+([^.!?]{0,80}?(?:[.!?]|\d{4}))\s*$/u', $t, $m)) {
                $cands[] = $m[1];
            }
            foreach ($cands as $c) {
                $c = trim($c);
                if (mb_strlen($c) < 12 || mb_strlen($c) > 100) {
                    continue;
                }
                if (str_starts_with($c, '(') || preg_match('/^(?:ibid|see|cf|op\. cit)\b/i', $c)) {
                    continue;    // citations repeat by nature
                }
                if (!preg_match('/\p{L}{4,}/u', $c)) {
                    continue;
                }
                if (!preg_match('/[\d©:|,.\/]/u', $c)) {
                    continue;    // bare words — a name under "About the Author", not a running head
                }
                if (preg_match('/,$/u', $c) && !preg_match('/[\d©|\/]/u', $c)) {
                    // "Dear Engels," / "My dear Friend," / "Yours fraternally," — a letter's
                    // salutation or sign-off repeats down a volume of correspondence by nature
                    // (Letters of Marx and Engels: 150 of the shelf's 231 "chrome leaks"). A
                    // running head does not end on a comma.
                    continue;
                }
                if (preg_match('/[—–-]\s*Ed\.?\]?$/u', $c)) {
                    continue;    // "In the manuscript: “the”.—Ed." — an editor's note, repeated because the slip is
                }
                if (preg_match(self::PROVENANCE_LINE, $c)) {
                    continue;    // "Source: …; Transcribed: by …" — the archive's record of the text, printed once per piece
                }
                $out[] = preg_replace('/\d/', '#', $c);
            }
        }
        return $out;
    }

    /**
     * The paragraph stops mid-sentence: long enough to be prose, no sentence-final mark, and it
     * ends on a WORD — not a URL, an e-mail address, or a "label: value" line (an affiliation
     * block, a variable glossary "vk: value of resource number k" — 7fa30289 / 9a266e34).
     */
    private function leavesSentenceOpen(string $prev): bool
    {
        $prev = rtrim($prev);
        if (mb_strlen($prev) < 40 || preg_match(self::TERMINAL, $prev)) {
            return false;
        }
        $last = preg_split('/\s+/u', $prev);
        $last = end($last);
        if (preg_match('#[@/]|^www\.|\.\w{2,4}$#', $last)) {
            return false;
        }
        if (preg_match('/^\S{1,12}:\s/u', $prev)) {
            return false;
        }
        return (bool) preg_match('/[\p{L},\-–]$/u', $prev);
    }

    private function runsThroughDisplay(array $body, int $i): bool
    {
        if ($i < 2 || $body[$i - 1]['tag'] !== 'img') {
            return false;
        }
        $caption = '/^\s*(?:Figure|Fig\.|Table|Abbildung|Abb\.|Tabelle|Graph|Chart)\s*\d+/iu';
        foreach ([$i - 2, $i, $i + 1] as $j) {
            if (isset($body[$j]) && $j !== $i && preg_match($caption, $body[$j]['text'])) {
                return false;
            }
        }
        // The half before the display must itself point at it, or end on a connective.
        return (bool) preg_match('/(?:\b(?:form|diagram|follows|below|by|as|that|where|is|of)|[:,])\s*$/iu', $body[$i - 2]['text']);
    }

    private function previousProse(array $body, int $i): ?array
    {
        $skipped = 0;
        for ($j = $i - 1; $j >= 0 && $skipped <= 1; $j--) {
            $tag = $body[$j]['tag'];
            if (in_array($tag, self::PROSE_TAGS, true)) {
                return $body[$j];
            }
            if (!in_array($tag, self::SKIPPABLE_TAGS, true)) {
                return null;     // a heading ends the paragraph — not a page-break split
            }
            $skipped++;
        }
        return null;
    }

    private function tag(string $html): string
    {
        return preg_match('/^\s*<([a-z0-9]+)/i', $html, $m) ? strtolower($m[1]) : '';
    }

    private function text(string $html): string
    {
        $html = preg_replace('/<sup class="footnote-ref".*?<\/sup>/s', '', $html);
        return trim(preg_replace('/\s+/u', ' ',
            html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    }

    private function norm(string $s, int $len): string
    {
        return mb_substr(trim(preg_replace('/[^a-z0-9]+/', ' ', mb_strtolower($s))), 0, $len);
    }
}
