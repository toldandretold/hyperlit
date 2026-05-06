<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Carbon\Carbon;
use App\Models\PgLibrary;
use App\Services\LibraryCardGenerator;
use Illuminate\Http\Request;

class UserHomeServerController extends Controller
{
    /**
     * Update the user's billing tier (status) in the database.
     */
    public function updateTier(Request $request)
    {
        $request->validate([
            'tier' => 'required|string|in:budget,solidarity,capitalist',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        DB::connection('pgsql_admin')->table('users')
            ->where('id', $user->id)
            ->update(['status' => $request->tier]);

        $tiers = config('services.billing_tiers', []);
        $tier = $tiers[$request->tier] ?? ['multiplier' => 1.5, 'label' => ucfirst($request->tier)];

        return response()->json([
            'success' => true,
            'tier' => $request->tier,
            'label' => $tier['label'],
            'multiplier' => $tier['multiplier'],
        ]);
    }

    /**
     * Sanitize username by removing all spaces
     * Allows URLs like /u/MrJohns to work with DB username "Mr Johns"
     */
    private function sanitizeUsername(string $username): string
    {
        return str_replace(' ', '', $username);
    }

    /**
     * Show user's homepage (for subdomain routing)
     */
    public function show(string $username, ?string $shelfId = null)
    {
        // Check if user exists using RLS bypass function (returns only public fields)
        // This allows looking up other users' profiles without exposing sensitive data
        $user = \App\Models\User::findByNamePublic($username);

        if (!$user) {
            abort(404, 'User not found');
        }

        // Use the actual DB username for all operations, but sanitized for book IDs
        $actualUsername = $user->name;
        $sanitizedUsername = $this->sanitizeUsername($actualUsername);

        // Check if viewer is owner (for delete buttons)
        $isOwner = Auth::check() && $this->sanitizeUsername(Auth::user()->name) === $sanitizedUsername;

        // Ensure user home books exist (only regenerate on first visit)
        $this->generateUserHomeBookIfNeeded($actualUsername, $isOwner, 'public');

        // Only generate private book, all book, and account book if owner
        if ($isOwner) {
            $this->generateUserHomeBookIfNeeded($actualUsername, $isOwner, 'private');
            $this->generateAllUserHomeBookIfNeeded($actualUsername);
            $this->generateAccountBookIfNeeded($actualUsername);
        }

        // Fetch library record for title and bio (use sanitized for book ID)
        $libraryRecord = DB::table('library')
            ->where('book', $sanitizedUsername)
            ->first();

        $title = $libraryRecord ? ($libraryRecord->title ?? "{$actualUsername}'s library") : "{$actualUsername}'s library";
        $bio = $libraryRecord ? ($libraryRecord->note ?? '') : '';

        // SEO data for user pages
        $pageTitle = "{$title} - Hyperlit";
        $pageDescription = $bio ? \Illuminate\Support\Str::limit(strip_tags($bio), 160) : "{$actualUsername}'s library on Hyperlit";

        // Fetch user's shelves if owner
        $shelves = [];
        if ($isOwner) {
            $shelves = DB::table('shelves')
                ->where('creator', $actualUsername)
                ->orderByDesc('updated_at')
                ->get(['id', 'name', 'slug', 'description', 'visibility', 'default_sort'])
                ->toArray();
        }

        // Fetch public shelves for visitors (also useful for owner, but primarily for visitors)
        $publicShelves = DB::connection('pgsql_admin')->table('shelves')
            ->where('creator', $actualUsername)
            ->where('visibility', 'public')
            ->orderByDesc('updated_at')
            ->get(['id', 'name', 'slug', 'description', 'visibility', 'default_sort'])
            ->toArray();

        // Validate activeShelfId: resolve by slug first, then fall back to UUID
        $activeShelfId = null;
        if ($shelfId) {
            $validShelf = collect($publicShelves)->firstWhere('slug', $shelfId)
                       ?? collect($publicShelves)->firstWhere('id', $shelfId);
            $activeShelfId = $validShelf ? $validShelf->id : null;
        }

        // Return user.blade.php with user page data (use sanitized for book ID)
        return view('user', [
            'pageType' => 'user',
            'book' => $sanitizedUsername,
            'allBook' => $sanitizedUsername . 'All',
            'username' => $actualUsername,
            'isOwner' => $isOwner,
            'libraryTitle' => $title,
            'libraryBio' => $bio,
            'pageTitle' => $pageTitle,
            'pageDescription' => $pageDescription,
            'ogType' => 'profile',
            'shelves' => $shelves,
            'publicShelves' => $publicShelves,
            'activeShelfId' => $activeShelfId,
        ]);
    }

    private function generateUserHomeBookIfNeeded(string $username, bool $isOwner, string $visibility): void
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $visibility === 'private' ? $sanitizedUsername . 'Private' : $sanitizedUsername;

        if (!DB::table('library')->where('book', $bookName)->exists()) {
            $this->generateUserHomeBook($username, $isOwner, $visibility);
            return;
        }

        // Failsafe: regenerate if actual book IDs don't match
        // Use admin connection to bypass RLS - trusted backend operation
        $libraryBooks = DB::connection('pgsql_admin')->table('library')
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'All')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->where('visibility', $visibility)
            ->pluck('book')
            ->sort()
            ->values();

        $nodeBooks = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookName)
            ->where('startLine', '>', 0)
            ->pluck('raw_json')
            ->map(fn ($json) => json_decode($json, true)['original_book'] ?? null)
            ->filter()
            ->sort()
            ->values();

        if ($libraryBooks->toArray() !== $nodeBooks->toArray()) {
            Log::info('Regenerating ' . $visibility . ' home book due to book ID mismatch.', [
                'username' => $username,
                'missing' => $libraryBooks->diff($nodeBooks)->values(),
                'extra' => $nodeBooks->diff($libraryBooks)->values(),
            ]);
            $this->generateUserHomeBook($username, $isOwner, $visibility);
        }
    }

    private function generateAllUserHomeBookIfNeeded(string $username): void
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $sanitizedUsername . 'All';

        if (!DB::table('library')->where('book', $bookName)->exists()) {
            $this->generateAllUserHomeBook($username);
            return;
        }

        // Failsafe: regenerate if actual book IDs don't match
        $libraryBooks = DB::connection('pgsql_admin')->table('library')
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'All')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->whereIn('visibility', ['public', 'private'])
            ->pluck('book')
            ->sort()
            ->values();

        $nodeBooks = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookName)
            ->where('startLine', '>', 0)
            ->pluck('raw_json')
            ->map(fn ($json) => json_decode($json, true)['original_book'] ?? null)
            ->filter()
            ->sort()
            ->values();

        if ($libraryBooks->toArray() !== $nodeBooks->toArray()) {
            Log::info('Regenerating All home book due to book ID mismatch.', [
                'username' => $username,
                'missing' => $libraryBooks->diff($nodeBooks)->values(),
                'extra' => $nodeBooks->diff($libraryBooks)->values(),
            ]);
            $this->generateAllUserHomeBook($username);
        }
    }

    public function generateAllUserHomeBook(string $username): array
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $sanitizedUsername . 'All';

        // Query ALL books (public + private)
        $records = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at', 'visibility'])
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'All')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->whereIn('visibility', ['public', 'private'])
            ->orderByDesc('created_at')
            ->get();

        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $bookName],
            [
                'author' => null, 'title' => $username . "'s library", 'visibility' => 'private', 'listed' => false, 'creator' => $username,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home', 'username' => $username, 'sanitized_username' => $sanitizedUsername, 'visibility' => 'all']),
                'timestamp' => round(microtime(true) * 1000), 'updated_at' => now(), 'created_at' => now(),
            ]
        );

        DB::connection('pgsql_admin')->table('nodes')->where('book', $bookName)->delete();

        // Invalidate sorted "all" variants
        DB::connection('pgsql_admin')->table('nodes')->where('book', 'LIKE', $sanitizedUsername . '_all_%')->delete();
        DB::connection('pgsql_admin')->table('library')->where('book', 'LIKE', $sanitizedUsername . '_all_%')->delete();

        $chunks = [];
        $positionId = 100;
        $generator = new LibraryCardGenerator();

        foreach ($records as $i => $record) {
            $isPrivate = ($record->visibility === 'private');
            $chunks[] = $generator->generateLibraryCardChunk($record, $bookName, $positionId, true, false, $i, 'public', false, $isPrivate);
            $positionId++;
        }

        if ($records->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $bookName, 1, true, true, 0, 'public');
        }

        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return ['success' => true, 'count' => count($chunks)];
    }

    private function generateAccountBookIfNeeded(string $username): void
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $sanitizedUsername . 'Account';

        if (!DB::table('library')->where('book', $bookName)->exists()) {
            $this->generateAccountBook($username);
        }
    }

    public function generateUserHomeBook(string $username, bool $currentUserIsOwner = null, string $visibility = 'public'): array
    {
        // Sanitize username for book IDs (removes spaces)
        $sanitizedUsername = $this->sanitizeUsername($username);

        // Determine book name based on visibility - use sanitized username
        $bookName = $visibility === 'private' ? $sanitizedUsername . 'Private' : $sanitizedUsername;

        // Query database using actual username for creator field
        // Use admin connection to bypass RLS - trusted backend operation
        // (RLS blocks private books when called from auth controller after token transfer)
        $records = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at'])
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'All')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->where('visibility', $visibility)
            ->orderByDesc('created_at')
            ->get();

        // Preserve existing highlights and cites
        // Build lookup map by original_book from raw_json to handle new node_id pattern
        $oldChunksRaw = DB::table('nodes')->where('book', $bookName)->get();
        $oldChunks = [];
        foreach ($oldChunksRaw as $chunk) {
            $rawJson = json_decode($chunk->raw_json ?? '{}', true);
            if (isset($rawJson['original_book'])) {
                $oldChunks[$rawJson['original_book']] = $chunk;
            }
        }

        // User home pages use admin connection - trusted backend operation
        // Safe because: PHP controls book name, only affects user home pages, user verified above
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $bookName],
            [
                'author' => null, 'title' => $username . "'s library", 'visibility' => $visibility, 'listed' => false, 'creator' => $username,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home', 'username' => $username, 'sanitized_username' => $sanitizedUsername, 'visibility' => $visibility]),
                'timestamp' => round(microtime(true) * 1000), 'updated_at' => now(), 'created_at' => now(),
            ]
        );

        DB::connection('pgsql_admin')->table('nodes')->where('book', $bookName)->delete();

        // Invalidate sorted variants when the default book is regenerated
        DB::connection('pgsql_admin')->table('nodes')->where('book', 'LIKE', $sanitizedUsername . '_' . $visibility . '_%')->delete();
        DB::connection('pgsql_admin')->table('library')->where('book', 'LIKE', $sanitizedUsername . '_' . $visibility . '_%')->delete();

        $chunks = [];

        $positionId = 100;
        // Use passed parameter if provided, otherwise check current auth state (compare sanitized)
        $isOwner = $currentUserIsOwner !== null ? $currentUserIsOwner : (Auth::check() && $this->sanitizeUsername(Auth::user()->name) === $sanitizedUsername);

        foreach ($records as $i => $record) {
            $newChunk = $this->generateLibraryCardChunk($record, $bookName, $positionId, $isOwner, false, $i);
            // Note: hypercites/hyperlights preservation removed - these are now in normalized tables
            $chunks[] = $newChunk;
            $positionId++;
        }

        if ($records->isEmpty()) {
             $chunks[] = $this->generateLibraryCardChunk(null, $bookName, 1, $isOwner, true, 0, $visibility);
        }

        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return ['success' => true, 'count' => count($chunks)];
    }

    public function addBookToUserPage(string $username, PgLibrary $bookRecord)
    {
        // Sanitize username for book IDs
        $sanitizedUsername = $this->sanitizeUsername($username);

        // Determine which book to update based on visibility
        $visibility = $bookRecord->visibility ?? 'public';
        $bookName = $visibility === 'private' ? $sanitizedUsername . 'Private' : $sanitizedUsername;

        $minStartLine = DB::table('nodes')
            ->where('book', $bookName)
            ->where('startLine', '>', 0)
            ->min('startLine');

        $newStartLine = ($minStartLine !== null) ? $minStartLine - 1 : 100;

        if ($newStartLine < 1) {
            $this->generateUserHomeBook($username, null, $visibility);
        } else {
            // For addBookToUserPage, always use current auth state (compare sanitized)
            $isOwner = Auth::check() && $this->sanitizeUsername(Auth::user()->name) === $sanitizedUsername;
            $chunk = $this->generateLibraryCardChunk($bookRecord, $bookName, $newStartLine, $isOwner, false, -1);
            DB::connection('pgsql_admin')->table('nodes')->insert($chunk);
            DB::connection('pgsql_admin')->table('library')->where('book', $bookName)->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        // Invalidate the "All" book so it regenerates on next visit
        $allBookName = $sanitizedUsername . 'All';
        DB::connection('pgsql_admin')->table('nodes')->where('book', $allBookName)->delete();
        DB::connection('pgsql_admin')->table('nodes')->where('book', 'LIKE', $sanitizedUsername . '_all_%')->delete();
        DB::connection('pgsql_admin')->table('library')->where('book', 'LIKE', $sanitizedUsername . '_all_%')->delete();

        return ['success' => true];
    }

    public function updateBookOnUserPage(string $username, PgLibrary $bookRecord)
    {
        // Sanitize username for book IDs
        $sanitizedUsername = $this->sanitizeUsername($username);

        // Determine which book to update based on visibility
        $visibility = $bookRecord->visibility ?? 'public';
        $bookName = $visibility === 'private' ? $sanitizedUsername . 'Private' : $sanitizedUsername;

        // Use new node_id pattern to find the card
        $expectedNodeId = $bookName . '_' . $bookRecord->book . '_card';
        $chunkToUpdate = DB::table('nodes')
            ->where('book', $bookName)
            ->where('node_id', $expectedNodeId)
            ->first();

        if ($chunkToUpdate) {
            $isOwner = Auth::check() && $this->sanitizeUsername(Auth::user()->name) === $sanitizedUsername;
            $newContent = $this->generateLibraryCardHtml($bookRecord, $chunkToUpdate->startLine, $isOwner, $expectedNodeId);
            $newRawJson = json_encode([
                'original_book' => $bookRecord->book, 'position_type' => 'user_home', 'position_id' => $chunkToUpdate->startLine,
                'bibtex' => $bookRecord->bibtex, 'title' => $bookRecord->title ?? null, 'author' => $bookRecord->author ?? null, 'year' => $bookRecord->year ?? null,
            ]);
            $newPlainText = strip_tags($this->generateCitationHtml($bookRecord));

            DB::connection('pgsql_admin')->table('nodes')->where('id', $chunkToUpdate->id)->update([
                'content' => $newContent,
                'raw_json' => $newRawJson,
                'plainText' => $newPlainText,
                'updated_at' => now(),
            ]);

            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookName)
                ->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        // Also update the card in the "All" book if it exists
        $allBookName = $sanitizedUsername . 'All';
        $allNodeId = $allBookName . '_' . $bookRecord->book . '_card';
        $allChunk = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $allBookName)
            ->where('node_id', $allNodeId)
            ->first();

        if ($allChunk) {
            $isOwner = Auth::check() && $this->sanitizeUsername(Auth::user()->name) === $sanitizedUsername;
            $isPrivate = ($bookRecord->visibility === 'private');
            $newContent = (new LibraryCardGenerator())->generateLibraryCardHtml($bookRecord, $allChunk->startLine, $isOwner, $allNodeId, false, $isPrivate);
            $newRawJson = json_encode([
                'original_book' => $bookRecord->book, 'position_type' => 'user_home', 'position_id' => $allChunk->startLine,
                'bibtex' => $bookRecord->bibtex, 'title' => $bookRecord->title ?? null, 'author' => $bookRecord->author ?? null, 'year' => $bookRecord->year ?? null,
            ]);
            $newPlainText = strip_tags($this->generateCitationHtml($bookRecord));

            DB::connection('pgsql_admin')->table('nodes')->where('id', $allChunk->id)->update([
                'content' => $newContent,
                'raw_json' => $newRawJson,
                'plainText' => $newPlainText,
                'updated_at' => now(),
            ]);

            DB::connection('pgsql_admin')->table('library')
                ->where('book', $allBookName)
                ->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        return ['success' => true];
    }

    /**
     * Generate the Account book with balance, tier, and transaction history.
     */
    public function generateAccountBook(string $username): array
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $sanitizedUsername . 'Account';
        $now = Carbon::now();
        $admin = DB::connection('pgsql_admin');

        // Upsert library record
        $admin->table('library')->updateOrInsert(
            ['book' => $bookName],
            [
                'author' => null, 'title' => $username . "'s account", 'visibility' => 'private', 'listed' => false, 'creator' => $username,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_account', 'username' => $username, 'sanitized_username' => $sanitizedUsername]),
                'timestamp' => round(microtime(true) * 1000), 'updated_at' => now(), 'created_at' => now(),
            ]
        );

        // Clear existing nodes
        $admin->table('nodes')->where('book', $bookName)->delete();

        // Fetch user billing data
        $user = $admin->table('users')->where('name', $username)->first();
        $credits = (float) ($user->credits ?? 0);
        $debits = (float) ($user->debits ?? 0);
        $balance = $credits - $debits;

        // Tier info
        $status = $user->status ?? 'budget';
        $tiers = config('services.billing_tiers', []);
        $tier = $tiers[$status] ?? $tiers['budget'] ?? ['multiplier' => 1.5, 'label' => 'Budget'];
        $tierLabel = $tier['label'] ?? ucfirst($status);
        $multiplier = $tier['multiplier'] ?? 1.5;

        // Fetch ledger entries
        $ledgerEntries = $admin->table('billing_ledger')
            ->where('user_id', $user->id)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get();

        $chunks = [];
        $positionId = 100;

        // Chunk 1 — Balance header
        $balanceClass = $balance >= 0 ? 'balance-positive' : 'balance-negative';
        $balanceFormatted = number_format(abs($balance), 2);
        $balanceSign = $balance < 0 ? '-' : '';
        $creditsFormatted = number_format($credits, 2);
        $debitsFormatted = number_format($debits, 2);
        $balanceNodeId = $bookName . '_balance_card';
        $chunks[] = [
            'raw_json' => json_encode(['position_type' => 'user_account', 'position_id' => $positionId, 'card' => 'balance']),
            'book' => $bookName, 'chunk_id' => 0, 'startLine' => $positionId, 'node_id' => $balanceNodeId, 'footnotes' => null,
            'content' => '<p class="totalCredit' . ($balance < 0 ? ' totalCredit-negative' : '') . '" id="' . $positionId . '" data-node-id="' . $balanceNodeId . '">'
                . '<strong class="' . $balanceClass . '">Balance: ' . $balanceSign . '$' . $balanceFormatted . '</strong>'
                . '<br><span>Debits: $' . $debitsFormatted . '</span>'
                . '<br><span>Credits: $' . $creditsFormatted . '</span>'
                . '<br><strong>Tier:</strong> ' . e($tierLabel) . ' (' . e($multiplier) . '&times;)'
                . ' <span class="tier-selector" data-current-tier="' . e($status) . '">&#9660;</span>'
                . '<span class="tier-dropdown hidden">'
                .   '<span class="tier-explainer"><em>By self-selecting your tier, you choose how much each PDF-conversion or Citation Review will cost. There are NO automatic payment renewals. Simply top up credits, and renew when needed. Why? Coz fuck having to remember all the stupid subscriptions you signed up for.</em></span>'
                .   '<span class="tier-option' . ($status === 'budget' ? ' active' : '') . '" data-tier="budget">'
                .     '<strong>Budget</strong> (1.5&times;)'
                .     '<br><em>Cover the cost of OCR API for PDF conversion, LLM compute for Citation Reviews, plus some web-hosting.</em>'
                .   '</span>'
                .   '<span class="tier-option' . ($status === 'solidarity' ? ' active' : '') . '" data-tier="solidarity">'
                .     '<strong>Solidarity</strong> (2&times;)'
                .     '<br><em>Cover costs and help me eat.</em>'
                .   '</span>'
                .   '<span class="tier-option' . ($status === 'capitalist' ? ' active' : '') . '" data-tier="capitalist">'
                .     '<strong>Honest Capitalist (rare)</strong> (5&times;)'
                .     '<br><em>If you are a capitalist firm or large institution, please pay accordingly. Or if you just wanna support more, that&#39;s based AF comrade &#129297;&#129297;&#129297;&#9994;&#9994;&#9994;</em>'
                .   '</span>'
                . '</span>'
                . '<br><a href="#" class="stripe-topup" data-topup-amount="5">Top Up</a>'
                . '</p>',
            'plainText' => "Balance: {$balanceSign}\${$balanceFormatted} Credits: \${$creditsFormatted} Debits: \${$debitsFormatted} Tier: {$tierLabel} ({$multiplier}×)",
            'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
        ];
        $positionId++;

        // Chunks 3+ — Transaction history
        if ($ledgerEntries->isEmpty()) {
            $emptyNodeId = $bookName . '_empty_ledger';
            $chunks[] = [
                'raw_json' => json_encode(['position_type' => 'user_account', 'position_id' => $positionId, 'card' => 'empty']),
                'book' => $bookName, 'chunk_id' => 0, 'startLine' => $positionId, 'node_id' => $emptyNodeId, 'footnotes' => null,
                'content' => '<p class="ledgerEntry" id="' . $positionId . '" data-node-id="' . $emptyNodeId . '"><em>No transactions yet.</em></p>',
                'plainText' => 'No transactions yet.', 'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
            ];
        } else {
            foreach ($ledgerEntries as $entry) {
                $isCredit = $entry->type === 'credit';
                $sign = $isCredit ? '+' : '-';
                $amt = number_format((float) $entry->amount, 2);
                $desc = e($entry->description);
                $cat = e($entry->category);
                $date = Carbon::parse($entry->created_at)->format('j M Y, H:i');
                $entryNodeId = $bookName . '_' . $entry->id;

                $chunks[] = [
                    'raw_json' => json_encode(['position_type' => 'user_account', 'position_id' => $positionId, 'ledger_id' => $entry->id]),
                    'book' => $bookName, 'chunk_id' => floor(count($chunks) / 100), 'startLine' => $positionId, 'node_id' => $entryNodeId, 'footnotes' => null,
                    'content' => '<p class="ledgerEntry" id="' . $positionId . '" data-node-id="' . $entryNodeId . '">'
                        . '<span>' . $sign . '$' . $amt . '</span>'
                        . ' &middot; ' . $desc
                        . ' &middot; ' . $cat
                        . ' &middot; ' . e($date)
                        . '</p>',
                    'plainText' => "{$sign}\${$amt} · {$entry->description} · {$entry->category} · {$date}",
                    'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
                ];
                $positionId++;
            }
        }

        // Batch insert
        foreach (array_chunk($chunks, 500) as $batch) {
            $admin->table('nodes')->insert($batch);
        }

        return ['success' => true, 'count' => count($chunks)];
    }

    private function generateLibraryCardChunk($record, string $bookName, int $positionId, bool $isOwner, bool $isEmpty = false, int $index = 0, string $visibility = 'public', bool $locked = false, bool $isPrivate = false)
    {
        return (new LibraryCardGenerator())->generateLibraryCardChunk($record, $bookName, $positionId, $isOwner, $isEmpty, $index, $visibility, $locked, $isPrivate);
    }

    private function generateLibraryCardHtml($record, int $positionId, bool $isOwner, string $nodeId, bool $locked = false, bool $isPrivate = false): string
    {
        return (new LibraryCardGenerator())->generateLibraryCardHtml($record, $positionId, $isOwner, $nodeId, $locked, $isPrivate);
    }

    private function generateCitationHtml($record)
    {
        return (new LibraryCardGenerator())->generateCitationHtml($record);
    }

    /**
     * Render a sorted view of the user's public or private library.
     * Creates a synthetic book with nodes sorted by the requested criteria.
     */
    public function renderSorted(Request $request)
    {
        $request->validate([
            'visibility' => 'required|string|in:public,private,all',
            'sort' => 'required|string|in:recent,connected,lit,title,author',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $username = $user->name;
        $sanitizedUsername = $this->sanitizeUsername($username);
        $visibility = $request->visibility;
        $sort = $request->sort;

        // "recent" = default book, no synthetic needed
        if ($sort === 'recent') {
            if ($visibility === 'all') {
                $bookName = $sanitizedUsername . 'All';
            } elseif ($visibility === 'private') {
                $bookName = $sanitizedUsername . 'Private';
            } else {
                $bookName = $sanitizedUsername;
            }
            return response()->json(['bookId' => $bookName]);
        }

        $syntheticBookId = $sanitizedUsername . '_' . $visibility . '_' . $sort;

        // Check cache
        if (DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->exists()) {
            return response()->json(['bookId' => $syntheticBookId]);
        }

        // Fetch + sort
        $query = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at', 'total_citations', 'total_highlights', 'visibility'])
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'All')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%');

        if ($visibility === 'all') {
            $query->whereIn('visibility', ['public', 'private']);
        } else {
            $query->where('visibility', $visibility);
        }

        $records = $query->get();

        $records = match ($sort) {
            'title' => $records->sortBy(fn($r) => mb_strtolower($r->title ?? '')),
            'author' => $records->sortBy(fn($r) => mb_strtolower($r->author ?? '')),
            'connected' => $records->sortByDesc('total_citations'),
            'lit' => $records->sortByDesc(fn($r) => ($r->total_citations ?? 0) + ($r->total_highlights ?? 0)),
            default => $records->sortByDesc('created_at'),
        };
        $records = $records->values();

        // Create synthetic library entry + nodes
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $syntheticBookId],
            [
                'title' => $username . "'s library ({$sort})",
                'visibility' => $visibility === 'all' ? 'private' : $visibility,
                'listed' => false,
                'creator' => $username,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home_sorted', 'username' => $username, 'visibility' => $visibility, 'sort' => $sort]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->delete();

        $generator = new LibraryCardGenerator();
        $chunks = [];
        $positionId = 100;
        foreach ($records as $i => $record) {
            $isPrivate = ($visibility === 'all' && ($record->visibility ?? 'public') === 'private');
            $chunks[] = $generator->generateLibraryCardChunk($record, $syntheticBookId, $positionId, true, false, $i, 'public', false, $isPrivate);
            $positionId++;
        }
        if ($records->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $syntheticBookId, 1, true, true, 0, $visibility === 'all' ? 'public' : $visibility);
        }
        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return response()->json(['bookId' => $syntheticBookId]);
    }

    /**
     * Public sorted render of a user's public library (no auth required).
     * Mirrors renderSorted() but resolves user by username, hardcodes public visibility.
     */
    public function publicRenderSorted(Request $request, string $username)
    {
        $request->validate([
            'sort' => 'required|string|in:recent,connected,lit,title,author',
        ]);

        $user = \App\Models\User::findByNamePublic($username);
        if (!$user) {
            return response()->json(['error' => 'User not found'], 404);
        }

        $actualUsername = $user->name;
        $sanitizedUsername = $this->sanitizeUsername($actualUsername);
        $sort = $request->sort;

        // "recent" = default book, no synthetic needed
        if ($sort === 'recent') {
            return response()->json(['bookId' => $sanitizedUsername]);
        }

        $syntheticBookId = $sanitizedUsername . '_public_' . $sort;

        // Check cache
        if (DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->exists()) {
            return response()->json(['bookId' => $syntheticBookId]);
        }

        // Fetch + sort
        $records = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at', 'total_citations', 'total_highlights'])
            ->where('creator', $actualUsername)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->where('visibility', 'public')
            ->get();

        $records = match ($sort) {
            'title' => $records->sortBy(fn($r) => mb_strtolower($r->title ?? '')),
            'author' => $records->sortBy(fn($r) => mb_strtolower($r->author ?? '')),
            'connected' => $records->sortByDesc('total_citations'),
            'lit' => $records->sortByDesc(fn($r) => ($r->total_citations ?? 0) + ($r->total_highlights ?? 0)),
            default => $records->sortByDesc('created_at'),
        };
        $records = $records->values();

        // Create synthetic library entry + nodes
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $syntheticBookId],
            [
                'title' => $actualUsername . "'s library ({$sort})",
                'visibility' => 'public',
                'listed' => false,
                'creator' => $actualUsername,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home_sorted', 'username' => $actualUsername, 'visibility' => 'public', 'sort' => $sort]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->delete();

        $generator = new LibraryCardGenerator();
        $chunks = [];
        $positionId = 100;
        foreach ($records as $i => $record) {
            $chunks[] = $generator->generateLibraryCardChunk($record, $syntheticBookId, $positionId, false, false, $i);
            $positionId++;
        }
        if ($records->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $syntheticBookId, 1, false, true, 0, 'public');
        }
        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return response()->json(['bookId' => $syntheticBookId]);
    }

}
