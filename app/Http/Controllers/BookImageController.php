<?php

namespace App\Http\Controllers;

use App\Models\PgBookImage;
use App\Models\PgLibrary;
use App\Services\BookImageStore;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Owner-side image management for the E2EE lock/publish passes (docs/e2ee.md).
 *
 * GET  /api/books/{book}/images        — list rows (under RLS; private books are
 *                                         owner-only automatically).
 * POST /api/books/{book}/images        — create one image from a client upload
 *                                         (raw body; server mints the filename).
 * PUT  /api/books/{book}/images/{file} — replace one image's bytes (raw body).
 *                                         The magic guard enforces the encrypted
 *                                         flag: an encrypted book only accepts
 *                                         HLENC1 ciphertext; a plaintext book
 *                                         only accepts non-magic bytes.
 */
class BookImageController extends Controller
{
    private const MAX_BYTES = 50 * 1024 * 1024;

    /** Raw binary magic that prefixes a ciphertext image blob (e2ee/crypto.ts BLOB_MAGIC). */
    public const BLOB_MAGIC = 'HLENC1';

    public function index(Request $request, string $book): JsonResponse
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        // RLS decides visibility (default connection).
        $rows = PgBookImage::where('book', $book)
            ->orderBy('filename')
            ->get(['filename', 'mime', 'bytes', 'width', 'height', 'encrypted']);

        return response()->json(['success' => true, 'images' => $rows]);
    }

    /**
     * Owner-only gate, mirroring ImportController@reconvert. Returns an error
     * JsonResponse (404/401/403) or null when the caller owns the book.
     */
    private function assertOwner(Request $request, string $book): ?JsonResponse
    {
        $library = PgLibrary::where('book', $book)->first();
        if (! $library) {
            return response()->json(['success' => false, 'message' => 'Book not found'], 404);
        }
        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (! ($creatorInfo['valid'] ?? false)) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $isOwner = ($library->creator && $library->creator === $creatorInfo['creator'])
            || ($library->creator_token && $creatorInfo['creator_token']
                && hash_equals((string) $library->creator_token, (string) $creatorInfo['creator_token']));
        if (! $isOwner) {
            return response()->json(['success' => false, 'message' => 'Access denied'], 403);
        }

        return null;
    }

    /**
     * Magic guard shared by store/update: the uploaded bytes' shape must match
     * the book's encryption state (E2EE review-gate backstop). Returns an error
     * JsonResponse or null when consistent.
     */
    private function assertMagicMatchesBook(bool $hasMagic, bool $bookEncrypted): ?JsonResponse
    {
        if ($bookEncrypted && ! $hasMagic) {
            return response()->json(['success' => false, 'message' => 'E2EE violation: encrypted book requires an HLENC1 image blob'], 422);
        }
        if (! $bookEncrypted && $hasMagic) {
            return response()->json(['success' => false, 'message' => 'Plaintext book cannot store an HLENC1 blob'], 422);
        }

        return null;
    }

    /**
     * Create one image from a client upload (raw body POST — the "Phase III
     * upload"). The server mints the final filename and returns it with the
     * canonical src. Query params: `name` (required, the user's original
     * filename, used for slug + extension), `w`/`h` (dims, used only for
     * encrypted uploads whose ciphertext the server can't measure).
     *
     * NOTE: deleting an image NODE in the editor does not delete this row or
     * file — orphans are accepted debt (node deletion is offline-capable and
     * undoable); pruneToFilenames reconciles on reconvert.
     */
    public function store(Request $request, string $book)
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        if ($err = $this->assertOwner($request, $book)) {
            return $err;
        }

        $originalName = (string) $request->query('name', '');
        if ($originalName === '') {
            return response()->json(['success' => false, 'message' => 'Missing image name'], 422);
        }
        $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        if (! in_array($ext, BookImageStore::ALLOWED_EXTENSIONS, true)) {
            return response()->json(['success' => false, 'message' => 'Disallowed image type'], 422);
        }

        $body = $request->getContent();
        if ($body === '' || strlen($body) > self::MAX_BYTES) {
            return response()->json(['success' => false, 'message' => 'Empty or oversized image'], 422);
        }

        $hasMagic = str_starts_with($body, self::BLOB_MAGIC);
        $bookEncrypted = EncryptedBookGuard::isEncrypted($book);
        if ($err = $this->assertMagicMatchesBook($hasMagic, $bookEncrypted)) {
            return $err;
        }

        $width = $request->filled('w') ? (int) $request->query('w') : null;
        $height = $request->filled('h') ? (int) $request->query('h') : null;

        $tmp = tempnam(sys_get_temp_dir(), 'hlimg');
        file_put_contents($tmp, $body);
        try {
            $stored = app(BookImageStore::class)->storeUploaded(
                $book, $originalName, $tmp, $hasMagic, $width, $height
            );
        } finally {
            @unlink($tmp);
        }

        return response()->json([
            'success' => true,
            'filename' => $stored['filename'],
            'width' => $stored['width'],
            'height' => $stored['height'],
            'encrypted' => $hasMagic,
            'src' => "/{$book}/media/{$stored['filename']}",
        ], 201);
    }

    public function update(Request $request, string $book, string $filename)
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        if ($err = $this->assertOwner($request, $book)) {
            return $err;
        }

        // Row must already exist — this endpoint REPLACES bytes (encrypt/publish),
        // it doesn't create images (that's the conversion ingest / Phase III upload).
        $row = PgBookImage::where('book', $book)->where('filename', $filename)->first();
        if (! $row) {
            return response()->json(['success' => false, 'message' => 'Image not found'], 404);
        }

        $body = $request->getContent();
        if ($body === '' || strlen($body) > self::MAX_BYTES) {
            return response()->json(['success' => false, 'message' => 'Empty or oversized image'], 422);
        }

        // Magic guard: the on-disk bytes' shape must match the book's encryption.
        // A ciphertext image blob is the raw binary HLENC1 envelope (see
        // e2ee/crypto.ts encryptBytes) — distinct from the text `hlenc.v1.`
        // string envelope.
        $hasMagic = str_starts_with($body, self::BLOB_MAGIC);
        $bookEncrypted = EncryptedBookGuard::isEncrypted($book);
        if ($err = $this->assertMagicMatchesBook($hasMagic, $bookEncrypted)) {
            return $err;
        }

        // Write via a temp file so the store does an atomic in-place replace.
        $tmp = tempnam(sys_get_temp_dir(), 'hlimg');
        file_put_contents($tmp, $body);
        try {
            app(BookImageStore::class)->replaceBytes($book, $row->filename, $tmp, $hasMagic);
        } finally {
            @unlink($tmp);
        }

        return response()->json(['success' => true, 'encrypted' => $hasMagic]);
    }
}
