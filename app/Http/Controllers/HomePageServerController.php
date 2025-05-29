<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class HomePageServerController extends Controller
{
    public function getHomePageBooks(Request $request)
    {
        $books = DB::table('library')
            ->select([
                'book',
                'timestamp as last_accessed',
                // Add any other fields you need from library table
            ])
            ->get()
            ->map(function ($book) {
                // Get first 3 nodes for each book
                $nodes = DB::table('node_chunks')
                    ->where('book', $book->book)
                    ->orderBy('start_line', 'asc')
                    ->limit(3)
                    ->get();

                return [
                    'book' => $book->book,
                    'lastAccessed' => strtotime($book->last_accessed), // Unix timestamp for easy sorting
                    'viewCount' => $this->getViewCount($book->book),
                    'citationCount' => $this->getCitationCount($book->book),
                    'highlightCount' => $this->getHighlightCount($book->book),
                    'nodes' => $nodes->toArray()
                ];
            });

        return response()->json([
            'books' => $books,
            'timestamp' => now()->timestamp
        ]);
    }

    private function getViewCount($book)
    {
        // Implement your view count logic
        // This might be from a separate views table or calculated field
        return 0; // Placeholder
    }

    private function getCitationCount($book)
    {
        // Implement your citation count logic
        return 0; // Placeholder
    }

    private function getHighlightCount($book)
    {
        // Implement your highlight count logic
        return 0; // Placeholder
    }
}
