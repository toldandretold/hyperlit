<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Carbon\Carbon;
use App\Models\PgLibrary;
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
    public function show(string $username)
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

        // Only generate private book and account book if owner
        if ($isOwner) {
            $this->generateUserHomeBookIfNeeded($actualUsername, $isOwner, 'private');
            $this->generateAccountBookIfNeeded($actualUsername);
        }

        // Fetch library record for title and bio (use sanitized for book ID)
        $libraryRecord = DB::table('library')
            ->where('book', $sanitizedUsername)
            ->first();

        $title = $libraryRecord ? ($libraryRecord->title ?? "{$actualUsername}'s library") : "{$actualUsername}'s library";
        $bio = $libraryRecord ? ($libraryRecord->note ?? '') : '';

        // Return user.blade.php with user page data (use sanitized for book ID)
        return view('user', [
            'pageType' => 'user',
            'book' => $sanitizedUsername,
            'username' => $actualUsername,
            'isOwner' => $isOwner,
            'libraryTitle' => $title,
            'libraryBio' => $bio,
        ]);
    }

    private function generateUserHomeBookIfNeeded(string $username, bool $isOwner, string $visibility): void
    {
        $sanitizedUsername = $this->sanitizeUsername($username);
        $bookName = $visibility === 'private' ? $sanitizedUsername . 'Private' : $sanitizedUsername;

        if (!DB::table('library')->where('book', $bookName)->exists()) {
            $this->generateUserHomeBook($username, $isOwner, $visibility);
        }
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
        $records = DB::table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at'])
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('book', '!=', $sanitizedUsername . 'Account')
            ->where('book', 'NOT LIKE', '%/%')
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

    private function generateLibraryCardChunk($record, string $bookName, int $positionId, bool $isOwner, bool $isEmpty = false, int $index = 0, string $visibility = 'public')
    {
        $now = Carbon::now();

        if ($isEmpty || !$record) {
            $emptyMessage = $visibility === 'private'
                ? '<em>no private hypertext</em>'
                : '<em>no public hypertext</em>';

            $emptyNodeId = $bookName . '_empty_card';
            return [
                'raw_json' => json_encode(['original_book' => null, 'position_type' => 'user_home', 'position_id' => 1, 'empty' => true]),
                'book' => $bookName, 'chunk_id' => 0, 'startLine' => 1, 'node_id' => $emptyNodeId,
                'footnotes' => null,
                'content' => '<p class="libraryCard" id="1" data-node-id="' . $emptyNodeId . '">' . $emptyMessage . '</p>',
                'plainText' => strip_tags($emptyMessage), 'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
            ];
        }

        // Generate unique node_id using pattern: {username}_{bookId}_card
        $nodeId = $bookName . '_' . $record->book . '_card';
        $content = $this->generateLibraryCardHtml($record, $positionId, $isOwner, $nodeId);

        return [
            'raw_json' => json_encode([
                'original_book' => $record->book, 'position_type' => 'user_home', 'position_id' => $positionId,
                'bibtex' => $record->bibtex, 'title' => $record->title ?? null, 'author' => $record->author ?? null, 'year' => $record->year ?? null,
            ]),
            'book' => $bookName,
            'chunk_id' => ($index < 0) ? 0 : floor($index / 100),
            'startLine' => $positionId,
            'node_id' => $nodeId,
            'footnotes' => null,
            'content' => $content,
            'plainText' => strip_tags($this->generateCitationHtml($record)),
            'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
        ];
    }

    private function generateLibraryCardHtml($record, int $positionId, bool $isOwner, string $nodeId): string
    {
        $citationHtml = $this->generateCitationHtml($record);
        $content = '<p class="libraryCard" id="' . $positionId . '" data-node-id="' . $nodeId . '">' . $citationHtml . '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>';

        if ($isOwner) {
            $content .= '<a href="#" class="delete-book" data-book="' . $record->book . '" title="Delete" aria-label="Delete">'
                . '<svg id="svgDeleter" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
                . '<path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                . '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                . '</svg></a>';
        }
        $content .= '</p>';
        return $content;
    }

    private function generateCitationHtml($record)
    {
        $hasTitle = !empty($record->title);
        $hasAuthor = !empty($record->author);
        $hasYear = !empty($record->year);
        $hasPublisher = !empty($record->publisher);
        $hasJournal = !empty($record->journal);

        if (!$hasTitle && !$hasAuthor && !$hasYear && !$hasPublisher && !$hasJournal) {
            return 'Anon., <em>Unreferenced</em>';
        }

        $html = '';
        if ($hasAuthor) {
            $html .= '<strong>' . e($record->author) . '</strong>. ';
        } else {
            $html .= '<strong>Anon.</strong> ';
        }

        if ($hasTitle) {
            if ($hasJournal) {
                $html .= '"' . e($record->title) . '." ';
            } else {
                $html .= '<em>' . e($record->title) . '</em>. ';
            }
        } else {
            $html .= '<em>Unreferenced</em>. ';
        }

        if ($hasJournal) {
            $html .= '<em>' . e($record->journal) . '</em>. ';
        }
        if ($hasPublisher && !$hasJournal) {
            $html .= e($record->publisher) . '. ';
        }
        if ($hasYear) {
            $html .= e($record->year);
        }

        $html = preg_replace('/\s+/', ' ', $html);
        $html = trim($html);
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }
        return $html;
    }

}
