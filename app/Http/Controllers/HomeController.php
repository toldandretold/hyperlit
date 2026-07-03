<?php

namespace App\Http\Controllers;

class HomeController extends Controller
{
    /**
     * Show the application's homepage.
     *
     * @return \Illuminate\Contracts\Support\Renderable
     */
    public function index()
    {
        return view('home', [
            'pageType' => 'home',
            'pageTitle' => 'Hyperlit - Read, write and self-publish hypertext literature',
            // ~155 chars: this is the SERP snippet — feature vocabulary here is for
            // click-through; ranking for these terms needs them in crawlable content.
            'pageDescription' => 'Read, write and publish hypertext literature on an open source docuverse. Featuring: two-way hyperlink citations; AI citation review; AI archivist; and PDF, word, and epubc conversion. Export academic texts to markdown for local obsidian workflows.',
            'keywords' => 'hypertext literature, annotation, AI citation review, semantic search, vector embedding search, PDF to Markdown, EPUB conversion, Word export, self-publishing, open access, hyperlights, hypercites, footnotes, citations, digital knowledge commons',
            // No card prerender: the homepage defers content until a tab is
            // pressed (the lava-lamp hero). The crawlable SEO body is the
            // .welcome-copy copy in home.blade.php + the JSON-LD below.
            'jsonLd' => $this->buildHomeJsonLd(),
        ]);
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
                    'alternateName' => 'hyperlit.io',
                    'description' => 'Read, write and publish hypertext literature — open source, with AI citation review, semantic search, and PDF/EPUB to Markdown & Word conversion.',
                    'publisher' => ['@id' => url('/') . '#organization'],
                ],
                [
                    '@type' => 'Organization',
                    '@id' => url('/') . '#organization',
                    'name' => 'Hyperlit',
                    'url' => url('/'),
                    'logo' => ['@type' => 'ImageObject', 'url' => asset('images/og-card.png')],
                    'sameAs' => ['https://github.com/toldandretold/hyperlit'],
                ],
                [
                    '@type' => 'WebApplication',
                    '@id' => url('/') . '#app',
                    'name' => 'Hyperlit',
                    'url' => url('/'),
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
