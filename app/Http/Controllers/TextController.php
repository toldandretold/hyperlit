<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Http\Controllers\ConversionController;
use App\Helpers\BookSlugHelper;
use League\CommonMark\CommonMarkConverter;

class TextController extends Controller
{
    public function show(Request $request, $book, $hl = null, $fn = null)
    {
        // Sub-book interception removed — level-1 sub-book URLs (e.g. /book/Fn123)
        // now load the parent book and JS auto-opens the item in HyperlitContainer.
        // For standalone sub-book loading, use /based/{subBookId}.

        // If the path matches a username (allow basic slug variants),
        // (re)generate a user-home pseudo-book in DB and point $book to that.
        $possible = urldecode($book);
        $normalized = str_replace(['_', '-'], ' ', $possible);
        $username = null;
        if (\App\Models\User::where('name', $possible)->exists()) {
            $username = $possible;
        } elseif (\App\Models\User::where('name', $normalized)->exists()) {
            $username = $normalized;
        }

        if ($username !== null) {
            $bookCount = DB::table('library')->where('creator', $username)->where('book', '!=', $username)->count();
            $nodeCount = DB::table('nodes')->where('book', $username)->where('startLine', '>', 0)->count();

            // Generate the user-home book if it doesn't exist OR if the counts are out of sync.
            if ($nodeCount === 0 || $bookCount !== $nodeCount) {
                $isCurrentUserOwner = \Illuminate\Support\Facades\Auth::check() && \Illuminate\Support\Facades\Auth::user()->name === $username;
                Log::info('Regenerating user page due to count mismatch or non-existence.', ['username' => $username, 'book_count' => $bookCount, 'node_count' => $nodeCount, 'is_owner' => $isCurrentUserOwner]);
                $generator = new \App\Http\Controllers\UserHomeServerController();
                // RLS allows user home page writes via type='user_home' exception
                $generator->generateUserHomeBook($username, $isCurrentUserOwner, 'public');
            }

            $book = $username;
        }

        // Resolve slug → real book ID (preserves original value if not a slug)
        $urlSlug = $book; // keep the original URL segment for slug detection
        $book = BookSlugHelper::resolve($book);
        // Determine the slug to pass to the view
        $slug = BookSlugHelper::getSlug($book) ?? '';

        $editMode = $request->boolean('edit') || $request->routeIs('book.edit');

        // Fetch library metadata for SEO
        $seoData = $this->buildSeoData($book);

        // Check all possible data sources
        $bookExistsInDB = DB::table('nodes')->where('book', $book)->exists();
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $htmlPath = resource_path("markdown/{$book}/main-text.html");
        $markdownExists = File::exists($markdownPath);
        $htmlExists = File::exists($htmlPath);

        // Determine data source priority and handle accordingly
        if ($bookExistsInDB) {
            // PostgreSQL has the data - serve empty HTML, let JS load from DB
            return view('reader', array_merge([
                'html' => '',
                'book' => $book,
                'slug' => $slug,
                'editMode' => $editMode,
                'dataSource' => 'database',
                'pageType' => 'reader'
            ], $seoData));
        }

        if ($markdownExists || $htmlExists) {
            // File system has the data - process files as before
            $convertToHtml = false;
            if ($markdownExists) {
                if (!$htmlExists) {
                    $convertToHtml = true;
                } else {
                    $markdownModified = File::lastModified($markdownPath);
                    $htmlModified = File::lastModified($htmlPath);
                    if ($markdownModified > $htmlModified) {
                        $convertToHtml = true;
                    }
                }
            }

            if ($convertToHtml) {
                $markdown = File::get($markdownPath);
                $markdown = $this->normalizeMarkdown($markdown);
                $conversionController = new ConversionController($book);
                File::put($markdownPath, $markdown);
                $html = $conversionController->markdownToHtml();
            } else {
                $html = File::get($htmlPath);
            }

            return view('reader', array_merge([
                'html' => $html,
                'book' => $book,
                'slug' => $slug,
                'editMode' => $editMode,
                'dataSource' => 'filesystem',
                'pageType' => 'reader'
            ], $seoData));
        }

        // Neither PostgreSQL nor filesystem has it - assume it might be in IndexedDB
        // Always serve the reader view and let frontend JS check IndexedDB
        return view('reader', array_merge([
            'html' => '',
            'book' => $book,
            'slug' => $slug,
            'editMode' => $editMode,
            'dataSource' => 'indexeddb', // Frontend will check IndexedDB
            'pageType' => 'reader'
        ], $seoData));
    }


    /**
     * Time machine: read-only historical view of a book at a specific timestamp.
     * URL: /{book}/timemachine?at={timestamp}
     */
    public function showTimeMachine(Request $request, $book)
    {
        $book = BookSlugHelper::resolve($book);
        $timestamp = $request->query('at');

        if (!$timestamp) {
            return redirect("/{$book}");
        }

        return view('reader', [
            'html'                 => '',
            'book'                 => $book . '/timemachine',
            'realBook'             => $book,
            'editMode'             => false,
            'dataSource'           => 'database',
            'pageType'             => 'timemachine',
            'timeMachineTimestamp'  => $timestamp,
        ]);
    }

    /**
     * Standalone mode: load a sub-book as a full-screen book.
     * URL: /based/{subBookId}
     */
    public function showStandalone(Request $request, $subBookId)
    {
        if (!DB::table('nodes')->where('book', $subBookId)->exists()) {
            abort(404, 'Sub-book not found.');
        }

        return view('reader', [
            'html'       => '',
            'book'       => $subBookId,
            'editMode'   => $request->boolean('edit'),
            'dataSource' => 'database',
            'pageType'   => 'reader',
        ]);
    }

    /**
     * Nested mode: load parent book with an auto-open chain for sequential container opening.
     * URL: /{book}/{rest}  where rest = "2/Fn.../HL_..."
     */
    public function showNested(Request $request, $book, $rest)
    {
        // Resolve slug → real book ID
        $book = BookSlugHelper::resolve($book);
        $slug = BookSlugHelper::getSlug($book) ?? '';

        $parts = explode('/', $rest);
        $level = (int) $parts[0];
        $urlItems = array_slice($parts, 1);

        if (count($urlItems) < 1) {
            abort(404, 'Invalid nested URL.');
        }

        // Construct the final sub_book_id from URL components
        // Level 1 format: "book/itemId"  |  Level 2+ format: "book/level/parentItem/itemId"
        if ($level <= 1 && count($urlItems) === 1) {
            $finalSubBookId = $book . '/' . $urlItems[0];
        } else {
            $finalSubBookId = $book . '/' . $rest;
        }

        // Walk backwards from leaf to root to discover full chain
        $chain = $this->walkChainToRoot($book, $finalSubBookId);

        if ($chain === null) {
            abort(404, 'Sub-book chain not found.');
        }

        $editMode = $request->boolean('edit') || $request->routeIs('book.edit');

        // SEO: fetch book metadata + hyperlight text for link previews
        $seoData = $this->buildSeoData($book);
        $hlDescription = $this->getHyperlightDescription($finalSubBookId, $urlItems);
        if ($hlDescription) {
            $seoData['ogDescription'] = $hlDescription;
            $seoData['pageDescription'] = $hlDescription;
        }

        return view('reader', array_merge([
            'html'           => '',
            'book'           => $book,
            'slug'           => $slug,
            'editMode'       => $editMode,
            'dataSource'     => 'database',
            'pageType'       => 'reader',
            'autoOpenChain'  => $chain,
        ], $seoData));
    }

    /**
     * API endpoint: resolve a sub-book chain server-side.
     * Reuses walkChainToRoot + findParentBook against PostgreSQL.
     */
    public function resolveChainApi(Request $request, string $book, string $rest): \Illuminate\Http\JsonResponse
    {
        // Resolve slug → real book ID
        $book = BookSlugHelper::resolve($book);

        $parts = explode('/', $rest);
        $level = (int) $parts[0];
        $urlItems = array_slice($parts, 1);

        if (count($urlItems) < 1) {
            return response()->json(['success' => false, 'message' => 'Invalid path'], 400);
        }

        if ($level <= 1 && count($urlItems) === 1) {
            $finalSubBookId = $book . '/' . $urlItems[0];
        } else {
            $finalSubBookId = $book . '/' . $rest;
        }

        $chain = $this->walkChainToRoot($book, $finalSubBookId);

        if ($chain === null) {
            return response()->json(['success' => false, 'message' => 'Chain not found'], 404);
        }

        return response()->json(['success' => true, 'chain' => $chain]);
    }

    private function walkChainToRoot(string $rootBook, string $leafSubBookId): ?array
    {
        $chain = [];
        $currentSubBookId = $leafSubBookId;
        $maxIterations = 20;

        for ($i = 0; $i < $maxIterations; $i++) {
            $parsed = \App\Helpers\SubBookIdHelper::parse($currentSubBookId);
            if (!$parsed['itemId']) return null;

            array_unshift($chain, [
                'itemId'    => $parsed['itemId'],
                'subBookId' => $currentSubBookId,
            ]);

            $parentBook = $this->findParentBook($currentSubBookId);
            if ($parentBook === null) return null;

            // Root reached when parentBook has no slashes
            if (!str_contains($parentBook, '/')) {
                return ($parentBook === $rootBook) ? $chain : null;
            }

            $currentSubBookId = $parentBook;
        }

        return null; // Safety limit hit
    }

    private function findParentBook(string $subBookId): ?string
    {
        $book = DB::table('footnotes')
            ->where('sub_book_id', $subBookId)
            ->value('book');

        if ($book !== null) return $book;

        return DB::table('hyperlights')
            ->where('sub_book_id', $subBookId)
            ->value('book');
    }

    private function buildSeoData(string $bookId): array
    {
        $library = DB::table('library')
            ->select([
                'title', 'author', 'abstract', 'year', 'publisher', 'journal',
                'volume', 'issue', 'pages', 'doi', 'language', 'editor',
                'booktitle', 'school', 'type', 'cited_by_count', 'slug',
            ])
            ->where('book', $bookId)
            ->first();

        if (!$library || (!$library->title && !$library->author)) {
            return [];
        }

        $title = $library->title ?? 'Untitled';
        $author = $library->author;
        $isArticle = !empty($library->journal);

        // Page title
        $pageTitle = $author ? "{$title} by {$author} - Hyperlit" : "{$title} - Hyperlit";

        // Description — rich citation string
        $pageDescription = '';
        if ($library->abstract) {
            $pageDescription = \Illuminate\Support\Str::limit(strip_tags($library->abstract), 160);
        } else {
            $parts = [];
            if ($author) $parts[] = $author;
            if ($title) $parts[] = $isArticle ? "\"{$title}\"" : $title;
            if ($library->journal) $parts[] = $library->journal;
            if ($library->volume) {
                $vol = "vol. {$library->volume}";
                if ($library->issue) $vol .= ", no. {$library->issue}";
                $parts[] = $vol;
            }
            if ($library->publisher && !$isArticle) $parts[] = $library->publisher;
            if ($library->year) $parts[] = $library->year;
            $pageDescription = implode('. ', $parts) . '. Read on Hyperlit.';
        }

        $seo = [
            'pageTitle' => $pageTitle,
            'pageDescription' => $pageDescription,
            'ogType' => $isArticle ? 'article' : 'book',
        ];

        // Google Scholar citation_* meta tags
        $citationMeta = [];
        $citationMeta['citation_title'] = $title;
        if ($author) $citationMeta['citation_author'] = $author;
        if ($library->year) $citationMeta['citation_publication_date'] = $library->year;
        if ($library->journal) $citationMeta['citation_journal_title'] = $library->journal;
        if ($library->publisher) $citationMeta['citation_publisher'] = $library->publisher;
        if ($library->volume) $citationMeta['citation_volume'] = $library->volume;
        if ($library->issue) $citationMeta['citation_issue'] = $library->issue;
        if ($library->doi) $citationMeta['citation_doi'] = $library->doi;
        if ($library->language) $citationMeta['citation_language'] = $library->language;
        if ($library->pages) {
            $citationMeta['citation_pages'] = $library->pages;
            // Try to extract first/last page
            if (preg_match('/^(\d+)\s*[-–]\s*(\d+)$/', $library->pages, $m)) {
                $citationMeta['citation_firstpage'] = $m[1];
                $citationMeta['citation_lastpage'] = $m[2];
            }
        }
        if ($library->booktitle) $citationMeta['citation_inbook_title'] = $library->booktitle;
        $seo['citationMeta'] = $citationMeta;

        // Keywords from metadata
        $keywords = [];
        if ($author) $keywords[] = $author;
        if ($library->journal) $keywords[] = $library->journal;
        if ($library->publisher && !$isArticle) $keywords[] = $library->publisher;
        if ($library->year) $keywords[] = $library->year;
        // Extract meaningful words from title (skip short/common words)
        if ($title) {
            $stopWords = ['the','a','an','and','or','of','in','on','at','to','for','is','it','by','with','from','as','this','that'];
            $titleWords = preg_split('/[\s,.:;!?\-]+/', strtolower($title));
            foreach ($titleWords as $w) {
                if (strlen($w) > 3 && !in_array($w, $stopWords)) {
                    $keywords[] = $w;
                }
            }
        }
        if ($library->booktitle) $keywords[] = $library->booktitle;
        if ($library->school) $keywords[] = $library->school;
        $seo['keywords'] = implode(', ', array_unique($keywords));

        // JSON-LD structured data
        $schemaType = $isArticle ? 'ScholarlyArticle' : 'Book';
        $jsonLd = [
            '@context' => 'https://schema.org',
            '@type' => $schemaType,
            'name' => $title,
            'url' => url()->current(),
        ];
        if ($author) $jsonLd['author'] = ['@type' => 'Person', 'name' => $author];
        if ($library->publisher) {
            $jsonLd['publisher'] = ['@type' => 'Organization', 'name' => $library->publisher];
        }
        if ($library->year) $jsonLd['datePublished'] = $library->year;
        if ($library->abstract) $jsonLd['abstract'] = \Illuminate\Support\Str::limit(strip_tags($library->abstract), 500);
        if ($library->language) $jsonLd['inLanguage'] = $library->language;
        if ($library->doi) $jsonLd['identifier'] = ['@type' => 'PropertyValue', 'propertyID' => 'DOI', 'value' => $library->doi];
        if ($library->pages) $jsonLd['pagination'] = $library->pages;
        if ($isArticle && $library->journal) {
            $jsonLd['isPartOf'] = [
                '@type' => 'Periodical',
                'name' => $library->journal,
            ];
            if ($library->volume) $jsonLd['volumeNumber'] = $library->volume;
            if ($library->issue) $jsonLd['issueNumber'] = $library->issue;
        }
        if ($library->editor) $jsonLd['editor'] = ['@type' => 'Person', 'name' => $library->editor];
        if ($library->cited_by_count) $jsonLd['citationCount'] = $library->cited_by_count;

        $seo['jsonLd'] = $jsonLd;

        return $seo;
    }

    private function getHyperlightDescription(string $subBookId, array $urlItems): ?string
    {
        // Check if the last URL item is a hyperlight (HL_...)
        $lastItem = end($urlItems);
        if (!$lastItem || !str_starts_with($lastItem, 'HL_')) {
            return null;
        }

        // Query the hyperlights table for the text content
        $hyperlight = DB::table('hyperlights')
            ->where('sub_book_id', $subBookId)
            ->first();

        if (!$hyperlight) {
            // Try matching by hyperlight_id in the parent book context
            $hlId = $lastItem;
            $parentBook = explode('/', $subBookId)[0] ?? null;
            if ($parentBook) {
                $hyperlight = DB::table('hyperlights')
                    ->where('book', $parentBook)
                    ->where('hyperlight_id', $hlId)
                    ->first();
            }
        }

        if ($hyperlight && !empty($hyperlight->highlightedText)) {
            return \Illuminate\Support\Str::limit(strip_tags($hyperlight->highlightedText), 200);
        }

        return null;
    }

    // Preprocess the markdown to handle soft line breaks
    private function normalizeMarkdown($markdown)
    {
        // Split markdown content by double newlines to preserve block-level elements
        $paragraphs = preg_split('/(\n\s*\n)/', $markdown, -1, PREG_SPLIT_DELIM_CAPTURE);

        // Iterate through each block and normalize only the inner soft line breaks, excluding code blocks, blockquotes, and lists
        foreach ($paragraphs as &$block) {
            // Skip processing if the block is a code block (either fenced or indented)
            if (preg_match('/^( {4}|\t)|(```)/m', $block)) {
                continue;  // Skip normalization for code blocks
            }

            // Skip processing if the block starts with a blockquote or a list item
            if (preg_match('/^\s*>|\d+\.\s|\*\s|-\s|\+\s/m', $block)) {
                continue;  // Skip normalization for blockquotes and lists
            }

            // If the block isn't just a delimiter (double newline), normalize inner soft line breaks
            if (!preg_match('/^\n\s*\n$/', $block)) {
                // Replace single newlines within a paragraph block with spaces
                $block = preg_replace('/(?<!\n)\n(?!\n)/', ' ', $block);
            }
        }

        // Recombine the paragraphs to maintain block structure
        return implode('', $paragraphs);
    }

    // Show the hyperlights content for a specific book
    public function showHyperlights($book)
    {
        // Define the path to the hyperlights markdown file
        $hyperLightsPath = resource_path("markdown/{$book}/hyperlights.md");

        // Check if the hyperlights markdown file exists
        if (!File::exists($hyperLightsPath)) {
            abort(404, "Hyperlights not found for book: $book");
        }

        // Load the hyperlights markdown file
        $markdown = File::get($hyperLightsPath);

        // Use CommonMarkConverter to convert the markdown to HTML
        $converter = new CommonMarkConverter();
        $html = $converter->convertToHtml($markdown);

        // Pass the converted HTML to the Blade template
        return view('hyperlights-md', [
            'html' => $html,
            'book' => $book
        ]);
    }

    public function showHyperlightsHTML($book)
    {
        // Define the path to the HTML file for this book
        $htmlFilePath = resource_path("markdown/{$book}/hyperlights.html");

        // Check if the HTML file exists
        if (!File::exists($htmlFilePath)) {
            abort(404, "Main HTML content not found for book: $book");
        }

        // Load the HTML file content
        $htmlContent = File::get($htmlFilePath);

        // Pass the content to the Blade template
        return view('hyperlights', [
            'htmlContent' => $htmlContent,  // Pass the HTML content
            'book' => $book
        ]);
    }
}
