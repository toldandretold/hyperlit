<?php

namespace App\Http\Controllers;

use App\Services\Archives\CertifiedArchivesQuery;
use App\Services\Books\PublicBookCorpus;
use App\Services\JournalHarvest\CertifiedJournalsQuery;
use Illuminate\Support\Facades\Cache;

class HomeController extends Controller
{
    /**
     * The site's one-line description, used BOTH as <meta name="description">
     * (and so og:/twitter:) and as the JSON-LD WebSite.description. One
     * constant because they were two divergent strings, which tells Google two
     * different things about the same site. 147 chars — Google truncates the
     * SERP snippet around 160.
     */
    private const DESCRIPTION = 'Read, write and publish hypertext literature on an open-source docuverse: two-way citations, AI citation review, and PDF, Word and EPUB conversion.';

    /**
     * Show the application's homepage.
     *
     * @return \Illuminate\Contracts\Support\Renderable
     */
    public function index(
        CertifiedJournalsQuery $certifiedJournals,
        CertifiedArchivesQuery $certifiedArchives,
        PublicBookCorpus $corpus,
    ) {
        return view('home', [
            'pageType' => 'home',
            // "Hyperlit" alone is a contested term — an npm package, two other
            // GitHub projects and a SourceForge project all own it, and Google
            // pads the SERP with "hyper-" near-misses. The title therefore
            // always carries a disambiguating qualifier, which is what makes
            // "hyperlit docuverse" / "open access docuverse" winnable while
            // brand authority is still being built.
            // The qualifier is the USER'S brand phrase verbatim (hero statement,
            // CITATION.cff) — never paraphrase it: "open-source docuverse for
            // open-access research". An invented variant shipped once and
            // reached Google's index before being caught.
            'pageTitle' => 'Hyperlit — an open-source docuverse for open-access research',
            // Google truncates the SERP snippet around 160 chars. The previous
            // string was 247 (and the comment claiming ~155 was simply wrong),
            // so the differentiating half was never shown — and it shipped the
            // typo "epubc" live into meta, og: and twitter: descriptions.
            // Feature vocabulary here is for click-through; RANKING for these
            // terms needs them in crawlable copy, which is .welcome-copy's job.
            'pageDescription' => self::DESCRIPTION,
            'keywords' => 'hypertext literature, annotation, AI citation review, semantic search, vector embedding search, PDF to Markdown, EPUB conversion, Word export, self-publishing, open access, hyperlights, hypercites, footnotes, citations, digital knowledge commons',
            // `/home` serves this identical view (routes/web.php), so without an
            // explicit canonical it self-canonicalized to /home and competed
            // with the real homepage as a duplicate. Not a 301: HomeSeoTest
            // asserts /home keeps serving the homepage.
            'canonicalUrl' => url('/'),
            'ogUrl' => url('/'),
            // No card prerender: the homepage defers content until a tab is
            // pressed (the lava-lamp hero). The crawlable SEO body is the
            // .welcome-copy copy in home.blade.php + the JSON-LD below.
            'jsonLd' => $this->buildHomeJsonLd(),
            // The diamond journals we host, for the copy block at the end of
            // .welcome-copy. Certified + at least one readable article, so the
            // list can never point at an empty journal page. No response cache
            // on this route, so a certify toggle is live on the next request.
            // The docuverse itself, at the end of .welcome-copy — and the
            // homepage's only crawlable path into the corpus, since the three
            // arranger tabs are <button>s Googlebot cannot click. It replaced a
            // 1x1 clipped anchor that did the same job dishonestly.
            'hyperciteMap' => $this->hyperciteMap($corpus),
            'certifiedJournals' => $certifiedJournals->forHomepage(),
            // Same two gates for the hypertext archives (/a/{slug}) — see
            // CertifiedArchivesQuery and docs/web-scrape-import.md.
            'certifiedArchives' => $certifiedArchives->forHomepage(),
        ]);
    }

    /**
     * The homepage's hypercite network: the CONNECTED CORE of the public library
     * — texts with at least one hypercite, plus the works they are hypercited
     * with. Null when nothing is connected yet.
     *
     * connectedOnly, unlike the journal and user maps: this corpus is the whole
     * public library, where unconnected texts are the overwhelming majority, so
     * the all-articles shape would be a field of hundreds of dots with a handful
     * of lines — and would hit JournalHyperciteMap::MAX_BLOB_DOTS as the library
     * grows, silently dropping part of it with no signal. Every public book is
     * still reachable from /books and the sitemap.
     *
     * ONE Cache::flexible wrapping BOTH the corpus query and the build, copying
     * UserHomeServerController: the build walks the whole `hypercites` table, and
     * stale-while-revalidate means that cost lands AFTER a response rather than
     * inline for whichever visitor hits the 15-minute expiry. The homepage has no
     * response cache, so this is the only thing standing between `/` and that
     * walk — and `/` is the page a certified-journals query once made take 4.8s.
     *
     * The value is ARRAY-WRAPPED deliberately: an empty/unconnected corpus builds
     * a null SVG, and a bare cached null reads as a miss and would rebuild the
     * edge walk on every single request.
     */
    private function hyperciteMap(PublicBookCorpus $corpus): ?string
    {
        $cached = Cache::flexible(
            'home-hypercite-map:v2',
            [900, 86400],
            fn () => ['svg' => app(\App\Services\JournalHarvest\JournalHyperciteMap::class)
                ->buildSvgForBooks(
                    $corpus->forHyperciteMap(),
                    'Hypercite network of the Hyperlit docuverse',
                    // DEFAULT_VOCAB's nouns, named explicitly: the homepage holds
                    // books, articles and archive documents alike, so "text" is
                    // the only honest noun for all of them.
                    ['noun' => 'text', 'plural' => 'texts', 'beyond' => 'beyond this collection'],
                    connectedOnly: true,
                )],
        );

        return $cached['svg'] ?? null;
    }

    /**
     * WebSite + Organization + WebApplication structured data for the brand query.
     * The featureList carries the feature vocabulary machine-readably. No
     * SearchAction — the site has no crawlable ?q= results URL.
     */
    private function buildHomeJsonLd(): array
    {
        return [
            '@context' => 'https://schema.org',
            '@graph' => [
                [
                    '@type' => 'WebSite',
                    '@id' => url('/') . '#website',
                    'url' => url('/'),
                    'name' => 'Hyperlit',
                    // Every name this entity is searched by. "hyperlit" alone
                    // is contested (an npm package, two GitHub projects, a
                    // SourceForge project), so the qualified forms are what
                    // Google can actually disambiguate on.
                    'alternateName' => ['hyperlit.io', 'Hyperlit docuverse'],
                    // Must match the <meta name="description"> the page emits.
                    // Two different strings here taught Google two different
                    // summaries of the same site.
                    'description' => self::DESCRIPTION,
                    'publisher' => ['@id' => url('/') . '#organization'],
                ],
                [
                    '@type' => 'Organization',
                    '@id' => url('/') . '#organization',
                    'name' => 'Hyperlit',
                    'url' => url('/'),
                    'logo' => ['@type' => 'ImageObject', 'url' => asset('images/og-card.png')],
                    // Every page that IS this organization elsewhere — how Google
                    // consolidates the entity instead of ranking the repo above
                    // the site for its own name. ORGANIZATION accounts only: the
                    // founder's personal LinkedIn is a Person, a different
                    // entity, and claiming the org is the person muddies the
                    // exact disambiguation this exists to win. Add the LinkedIn
                    // COMPANY page (linkedin.com/company/…) and the Wikidata
                    // item here when their URLs are to hand.
                    'sameAs' => [
                        'https://github.com/toldandretold/hyperlit',
                        'https://www.instagram.com/hyperlit.io/',
                        'https://www.youtube.com/@hyperlit-io',
                        // The Wikidata entity — the record Google's Knowledge
                        // Graph reads when deciding that "hyperlit" means this
                        // site and not the npm package. It cites the DOI and
                        // points back here, closing the identity loop.
                        'https://www.wikidata.org/wiki/Q141644822',
                    ],
                ],
                [
                    '@type' => 'WebApplication',
                    '@id' => url('/') . '#app',
                    'name' => 'Hyperlit',
                    'url' => url('/'),
                    // The software's DOI (Zenodo concept DOI — resolves to the
                    // latest release). On the WebApplication node, NOT the
                    // Organization: the DOI identifies the software, and mixing
                    // the two entities muddies the disambiguation sameAs exists
                    // for. Same identifier pattern the book pages use for THEIR
                    // DOIs (TextController::buildSeoData).
                    'sameAs' => ['https://doi.org/10.5281/zenodo.23133502'],
                    'identifier' => [
                        '@type' => 'PropertyValue',
                        'propertyID' => 'DOI',
                        'value' => '10.5281/zenodo.23133502',
                    ],
                    'applicationCategory' => 'EducationalApplication',
                    'operatingSystem' => 'Web',
                    'featureList' => [
                        'Hypertext reading and annotation with hyperlights and hypercites',
                        'AI citation review for academic references and bibliographies',
                        'Semantic in-text search using AI vector embeddings',
                        'PDF, EPUB and Word document conversion to hypertext',
                        'Export to Markdown and Word',
                        'Self-publishing with footnotes, citations and nested sub-books',
                    ],
                ],
            ],
        ];
    }

}
