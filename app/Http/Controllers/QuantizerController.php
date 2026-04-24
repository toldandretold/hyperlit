<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use App\Helpers\BookSlugHelper;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;
use App\Models\PgFootnote;

class QuantizerController extends Controller
{
    public function show(Request $request, $book)
    {
        $book = BookSlugHelper::resolve($book);

        if (!canAccessBookContent($book, $request)) {
            abort(403, 'Access denied.');
        }

        $library = PgLibrary::where('book', $book)->first();
        if (!$library) {
            abort(404, 'Book not found.');
        }

        $nodes = PgNodeChunk::where('book', $book)
            ->orderBy('startLine')
            ->get(['node_id', 'content', 'startLine', 'type']);

        $hyperlights = PgHyperlight::where('book', $book)
            ->where('hidden', false)
            ->get(['id', 'hyperlight_id', 'sub_book_id', 'node_id', 'charData', 'highlightedText', 'preview_nodes', 'annotation', 'creator', 'time_since']);

        $hypercites = PgHypercite::where('book', $book)
            ->get(['id', 'hyperciteId', 'node_id', 'charData', 'hypercitedText', 'citedIN', 'relationshipStatus', 'creator', 'time_since']);

        $footnotes = PgFootnote::where('book', $book)
            ->get(['footnoteId', 'sub_book_id', 'content', 'preview_nodes']);

        return view('quantizer', [
            'book'        => $book,
            'title'       => $library->title ?? $book,
            'author'      => $library->author ?? '',
            'nodes'       => $nodes,
            'hyperlights' => $hyperlights,
            'hypercites'  => $hypercites,
            'footnotes'   => $footnotes,
            'pageType'    => 'quantizer',
        ]);
    }

    /**
     * Fetch sub-book data for quantizer — includes sub_book_id on hyperlights
     * so the UI can detect deeper nesting levels.
     */
    public function subBookData(Request $request, string $parentBook, string $subId): JsonResponse
    {
        $parentBook = BookSlugHelper::resolve($parentBook);
        $bookId = $parentBook . '/' . $subId;

        if (!canAccessBookContent($parentBook, $request)) {
            return response()->json(['error' => 'Access denied'], 403);
        }

        $nodes = PgNodeChunk::where('book', $bookId)
            ->orderBy('startLine')
            ->get(['node_id', 'content', 'startLine']);

        $hyperlights = PgHyperlight::where('book', $bookId)
            ->where('hidden', false)
            ->get(['hyperlight_id', 'sub_book_id', 'node_id', 'charData', 'highlightedText', 'preview_nodes', 'creator', 'time_since']);

        $footnotes = PgFootnote::where('book', $bookId)
            ->get(['footnoteId', 'sub_book_id', 'content', 'preview_nodes']);

        return response()->json([
            'nodes'       => $nodes,
            'hyperlights' => $hyperlights,
            'footnotes'   => $footnotes,
        ]);
    }
}
