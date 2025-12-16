<?php

namespace App\Services;

use App\Models\PgLibrary;
use App\Http\Controllers\UserHomeServerController;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Service for library (book) operations.
 * Handles CRUD operations, stats updates, and homepage synchronization.
 */
class LibraryService
{
    public function __construct(
        protected AuthSessionService $authService
    ) {}

    /**
     * Find a library record by book ID.
     */
    public function findByBookId(string $bookId): ?PgLibrary
    {
        return PgLibrary::where('book', $bookId)->first();
    }

    /**
     * Update a library record with the provided data.
     * Only updates fields that are provided.
     */
    public function update(PgLibrary $library, array $data, array $creatorInfo): PgLibrary
    {
        return DB::transaction(function () use ($library, $data, $creatorInfo) {
            $updateData = $this->buildUpdateData($library, $data);

            $library->update($updateData);

            // Sync homepage if owner is a registered user
            if ($library->creator) {
                $this->syncHomepage($library->creator, $library);
            }

            return $library->refresh();
        });
    }

    /**
     * Create a new library record.
     */
    public function create(array $data, array $creatorInfo): PgLibrary
    {
        return DB::transaction(function () use ($data, $creatorInfo) {
            $title = $this->truncateTitle($data['title'] ?? null);

            $library = PgLibrary::create([
                'book' => $data['book'],
                'title' => $title,
                'author' => $data['author'] ?? null,
                'creator' => $creatorInfo['creator'],
                'creator_token' => $creatorInfo['creator_token'],
                'type' => $data['type'] ?? null,
                'timestamp' => $data['timestamp'] ?? now()->timestamp,
                'bibtex' => $data['bibtex'] ?? null,
                'visibility' => $data['visibility'] ?? 'private',
                'listed' => $data['listed'] ?? false,
                'year' => $data['year'] ?? null,
                'publisher' => $data['publisher'] ?? null,
                'journal' => $data['journal'] ?? null,
            ]);

            // Sync homepage if owner is a registered user
            if ($creatorInfo['creator']) {
                $this->syncHomepage($creatorInfo['creator'], $library);
            }

            return $library;
        });
    }

    /**
     * Update book statistics (counts).
     */
    public function updateStats(string $bookId): array
    {
        $library = $this->findByBookId($bookId);

        if (!$library) {
            throw new \Exception("Book not found: {$bookId}");
        }

        $stats = [
            'hyperlights_count' => DB::table('hyperlights')
                ->where('book', $bookId)
                ->count(),
            'hypercites_count' => DB::table('hypercites')
                ->where('book', $bookId)
                ->count(),
            'nodes_count' => DB::table('nodes')
                ->where('book', $bookId)
                ->count(),
        ];

        $library->update($stats);

        // Sync to homepage
        if ($library->creator) {
            $this->syncHomepage($library->creator, $library->refresh());
        }

        return $stats;
    }

    /**
     * Build update data array, preserving existing values for unset fields.
     */
    protected function buildUpdateData(PgLibrary $library, array $data): array
    {
        return [
            'title' => $this->truncateTitle($data['title'] ?? $library->title),
            'author' => $data['author'] ?? $library->author,
            'type' => $data['type'] ?? $library->type,
            'bibtex' => $data['bibtex'] ?? $library->bibtex,
            'timestamp' => $data['timestamp'] ?? $library->timestamp,
            'url' => $data['url'] ?? $library->url,
            'year' => $data['year'] ?? $library->year,
            'journal' => $data['journal'] ?? $library->journal,
            'pages' => $data['pages'] ?? $library->pages,
            'publisher' => $data['publisher'] ?? $library->publisher,
            'school' => $data['school'] ?? $library->school,
            'note' => $data['note'] ?? $library->note,
            'visibility' => $data['visibility'] ?? $library->visibility,
            'listed' => $data['listed'] ?? $library->listed,
        ];
    }

    /**
     * Truncate title to approximately 15 words.
     */
    protected function truncateTitle(?string $title): ?string
    {
        if (!$title) {
            return null;
        }

        $words = explode(' ', $title);
        if (count($words) > 15) {
            return implode(' ', array_slice($words, 0, 15)) . '...';
        }

        return $title;
    }

    /**
     * Sync book to user's homepage.
     */
    protected function syncHomepage(string $username, PgLibrary $library): void
    {
        try {
            app(UserHomeServerController::class)->updateBookOnUserPage($username, $library);
        } catch (\Exception $e) {
            Log::warning('Failed to sync homepage', [
                'user' => $username,
                'book' => $library->book,
                'error' => $e->getMessage()
            ]);
        }
    }
}
