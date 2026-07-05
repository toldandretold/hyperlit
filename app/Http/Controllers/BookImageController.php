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

    public function update(Request $request, string $book, string $filename)
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        // Owner-only, mirroring ImportController@reconvert.
        $library = PgLibrary::where('book', $book)->first();
        if (! $library) {
            return response()->json(['success' => false, 'message' => 'Book not found'], 404);
        }
        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (! ($creatorInfo['valid'] ?? false)) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $isOwner = ($library->creator && $library->creator === $creatorInfo['creator'])
            || ($library->creator_token && $library->creator_token === $creatorInfo['creator_token']);
        if (! $isOwner) {
            return response()->json(['success' => false, 'message' => 'Access denied'], 403);
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
        $hasMagic = str_starts_with($body, \App\Http\Controllers\BookImageController::BLOB_MAGIC);
        $bookEncrypted = EncryptedBookGuard::isEncrypted($book);

        if ($bookEncrypted && ! $hasMagic) {
            return response()->json(['success' => false, 'message' => 'E2EE violation: encrypted book requires an HLENC1 image blob'], 422);
        }
        if (! $bookEncrypted && $hasMagic) {
            return response()->json(['success' => false, 'message' => 'Plaintext book cannot store an HLENC1 blob'], 422);
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
