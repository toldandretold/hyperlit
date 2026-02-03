<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Models\PgNodeChunk;
use App\Models\PgHypercite;
use App\Models\PgHyperlight;
use App\Models\PgLibrary;
use Illuminate\Support\Facades\Auth;

class UnifiedSyncController extends Controller
{
    /**
     * Unified sync endpoint - handles all data types in a single atomic transaction
     *
     * Expected payload:
     * {
     *   "book": "book_123",
     *   "nodes": [...],
     *   "hypercites": [...],
     *   "hyperlights": [...],
     *   "hyperlightDeletions": [...],
     *   "library": {...}
     * }
     */
    public function sync(Request $request)
    {
        try {
            $data = $request->all();
            $bookId = $data['book'] ?? null;

            if (!$bookId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Book ID is required'
                ], 400);
            }

            Log::info('Unified sync started', [
                'book' => $bookId,
                'nodeChunks_count' => isset($data['nodes']) ? count($data['nodes']) : 0,
                'hypercites_count' => isset($data['hypercites']) ? count($data['hypercites']) : 0,
                'hyperlights_count' => isset($data['hyperlights']) ? count($data['hyperlights']) : 0,
                'hyperlightDeletions_count' => isset($data['hyperlightDeletions']) ? count($data['hyperlightDeletions']) : 0,
                'footnotes_count' => isset($data['footnotes']) ? count($data['footnotes']) : 0,
                'has_library' => isset($data['library']),
            ]);

            // SYNC AUDIT: Log incoming payload details for forensics
            $nodeDeleteActions = [];
            $nodeUpsertActions = [];
            if (!empty($data['nodes'])) {
                foreach ($data['nodes'] as $node) {
                    $action = $node['_action'] ?? 'upsert';
                    if ($action === 'delete') {
                        $nodeDeleteActions[] = [
                            'startLine' => $node['startLine'] ?? null,
                            'node_id' => $node['node_id'] ?? null,
                        ];
                    } else {
                        $nodeUpsertActions[] = $node['startLine'] ?? null;
                    }
                }
            }
            Log::channel('sync_audit')->info('INCOMING_PAYLOAD', [
                'book' => $bookId,
                'node_upserts' => count($nodeUpsertActions),
                'node_upsert_startLines' => $nodeUpsertActions,
                'node_deletes' => count($nodeDeleteActions),
                'node_delete_details' => $nodeDeleteActions,
                'hypercites' => isset($data['hypercites']) ? count($data['hypercites']) : 0,
                'library_timestamp' => $data['library']['timestamp'] ?? null,
                'user_agent' => $request->header('User-Agent'),
            ]);

            // Check for stale data ONLY when syncing nodes (not highlights/hypercites)
            // This prevents a stale device from overwriting newer data
            // NOTE: Uses nodes' actual book fields, not top-level request book (for cross-book hypercite support)
            if (!empty($data['nodes'])) {
                // Get unique books from node items (the books that will actually be modified)
                $nodeBooks = array_values(array_unique(array_filter(array_column($data['nodes'], 'book'))));

                foreach ($nodeBooks as $nodeBook) {
                    // Only check stale if library timestamp is for this book
                    $libraryBook = $data['library']['book'] ?? $bookId;
                    if ($libraryBook !== $nodeBook) {
                        Log::channel('sync_audit')->info('STALE_CHECK_SKIPPED', [
                            'book' => $nodeBook,
                            'reason' => 'library timestamp is for different book',
                            'library_book' => $libraryBook
                        ]);
                        continue;
                    }

                    $frontendTimestamp = $data['library']['timestamp'] ?? null;
                    $currentLibrary = PgLibrary::where('book', $nodeBook)->first();

                    if ($currentLibrary && $frontendTimestamp && $currentLibrary->timestamp > $frontendTimestamp) {
                        Log::channel('sync_audit')->warning('STALE_DATA_REJECTED', [
                            'book' => $nodeBook,
                            'frontend_timestamp' => $frontendTimestamp,
                            'server_timestamp' => $currentLibrary->timestamp
                        ]);

                        return response()->json([
                            'success' => false,
                            'error' => 'STALE_DATA',
                            'message' => 'Your book is out of date. Please refresh to get the latest version.',
                            'server_timestamp' => $currentLibrary->timestamp
                        ], 409);
                    }
                }
            }

            // Wrap everything in a transaction for atomicity
            $result = DB::transaction(function () use ($request, $data, $bookId) {
                $results = [
                    'nodes' => null,
                    'hypercites' => null,
                    'hyperlights' => null,
                    'hyperlightDeletions' => null,
                    'footnotes' => null,
                    'library' => null,
                ];

                // 1. Sync node chunks (if present)
                if (!empty($data['nodes'])) {
                    $nodeChunkController = new DbNodeChunkController();
                    $nodeChunkRequest = new Request(['book' => $bookId, 'data' => $data['nodes']]);
                    $nodeChunkRequest->setUserResolver(function () use ($request) {
                        return $request->user();
                    });
                    // Copy cookies
                    foreach ($request->cookies as $key => $value) {
                        $nodeChunkRequest->cookies->set($key, $value);
                    }

                    $response = $nodeChunkController->bulkTargetedUpsert($nodeChunkRequest);
                    $results['nodes'] = json_decode($response->getContent(), true);

                    if (!($results['nodes']['success'] ?? false)) {
                        throw new \Exception('Node chunks sync failed: ' . ($results['nodes']['message'] ?? 'Unknown error'));
                    }
                }

                // 2. Sync hypercites (if present)
                if (!empty($data['hypercites'])) {
                    Log::debug('Hypercites data received in unified sync', [
                        'book' => $bookId,
                        'hypercites' => $data['hypercites']
                    ]);

                    $hyperciteController = new DbHyperciteController();
                    $hyperciteRequest = new Request(['book' => $bookId, 'data' => $data['hypercites']]);
                    $hyperciteRequest->setUserResolver(function () use ($request) {
                        return $request->user();
                    });
                    foreach ($request->cookies as $key => $value) {
                        $hyperciteRequest->cookies->set($key, $value);
                    }

                    $response = $hyperciteController->upsert($hyperciteRequest);
                    $results['hypercites'] = json_decode($response->getContent(), true);

                    if (!($results['hypercites']['success'] ?? false)) {
                        throw new \Exception('Hypercites sync failed: ' . ($results['hypercites']['message'] ?? 'Unknown error'));
                    }
                }

                // 3. Sync hyperlights (if present)
                if (!empty($data['hyperlights'])) {
                    $hyperlightController = new DbHyperlightController();
                    $hyperlightRequest = new Request(['book' => $bookId, 'data' => $data['hyperlights']]);
                    $hyperlightRequest->setUserResolver(function () use ($request) {
                        return $request->user();
                    });
                    foreach ($request->cookies as $key => $value) {
                        $hyperlightRequest->cookies->set($key, $value);
                    }

                    $response = $hyperlightController->upsert($hyperlightRequest);
                    $results['hyperlights'] = json_decode($response->getContent(), true);

                    if (!($results['hyperlights']['success'] ?? false)) {
                        throw new \Exception('Hyperlights sync failed: ' . ($results['hyperlights']['message'] ?? 'Unknown error'));
                    }
                }

                // 4. Sync hyperlight deletions (if present)
                if (!empty($data['hyperlightDeletions'])) {
                    $hyperlightController = new DbHyperlightController();

                    foreach ($data['hyperlightDeletions'] as $item) {
                        $action = $item['_action'] ?? 'delete';

                        if ($action === 'delete') {
                            $deleteRequest = new Request(['book' => $item['book'], 'data' => [$item]]);
                            $deleteRequest->setUserResolver(function () use ($request) {
                                return $request->user();
                            });
                            foreach ($request->cookies as $key => $value) {
                                $deleteRequest->cookies->set($key, $value);
                            }

                            $response = $hyperlightController->delete($deleteRequest);
                            $deleteResult = json_decode($response->getContent(), true);

                            if (!($deleteResult['success'] ?? false)) {
                                throw new \Exception('Hyperlight deletion failed: ' . ($deleteResult['message'] ?? 'Unknown error'));
                            }
                        } elseif ($action === 'hide') {
                            $hideRequest = new Request(['book' => $item['book'], 'data' => [$item]]);
                            $hideRequest->setUserResolver(function () use ($request) {
                                return $request->user();
                            });
                            foreach ($request->cookies as $key => $value) {
                                $hideRequest->cookies->set($key, $value);
                            }

                            $response = $hyperlightController->hide($hideRequest);
                            $hideResult = json_decode($response->getContent(), true);

                            if (!($hideResult['success'] ?? false)) {
                                throw new \Exception('Hyperlight hide failed: ' . ($hideResult['message'] ?? 'Unknown error'));
                            }
                        }
                    }

                    $results['hyperlightDeletions'] = ['success' => true];
                }

                // 5. Sync footnotes (if present)
                // Group by each footnote's own book field to support cross-book citations
                if (!empty($data['footnotes'])) {
                    $footnotesByBook = [];
                    foreach ($data['footnotes'] as $footnote) {
                        $fnBook = $footnote['book'] ?? $bookId;
                        $footnotesByBook[$fnBook][] = $footnote;
                    }

                    foreach ($footnotesByBook as $fnBookId => $fnGroup) {
                        $footnoteController = new DbFootnoteController();
                        $footnoteRequest = new Request(['book' => $fnBookId, 'data' => $fnGroup]);
                        $footnoteRequest->setUserResolver(function () use ($request) {
                            return $request->user();
                        });
                        foreach ($request->cookies as $key => $value) {
                            $footnoteRequest->cookies->set($key, $value);
                        }

                        $response = $footnoteController->upsert($footnoteRequest);
                        $fnResult = json_decode($response->getContent(), true);

                        if (!($fnResult['success'] ?? false)) {
                            throw new \Exception('Footnotes sync failed: ' . ($fnResult['message'] ?? 'Unknown error'));
                        }
                    }

                    $results['footnotes'] = ['success' => true, 'message' => 'Footnotes synced successfully'];
                }

                // 6. Sync library record (if present)
                if (!empty($data['library'])) {
                    $libraryController = new DbLibraryController();
                    $libraryRequest = new Request(['data' => $data['library']]);
                    $libraryRequest->setUserResolver(function () use ($request) {
                        return $request->user();
                    });
                    foreach ($request->cookies as $key => $value) {
                        $libraryRequest->cookies->set($key, $value);
                    }

                    $response = $libraryController->upsert($libraryRequest);
                    $results['library'] = json_decode($response->getContent(), true);

                    if (!($results['library']['success'] ?? false)) {
                        throw new \Exception('Library sync failed: ' . ($results['library']['message'] ?? 'Unknown error'));
                    }
                }

                return $results;
            });

            Log::info('Unified sync completed successfully', [
                'book' => $bookId,
                'results' => array_map(function($r) { return $r['success'] ?? false; }, $result)
            ]);

            return response()->json([
                'success' => true,
                'message' => 'All data synced successfully',
                'results' => $result
            ]);

        } catch (\Exception $e) {
            Log::error('Unified sync failed', [
                'book' => $bookId ?? 'unknown',
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Sync failed',
                'error' => $e->getMessage()
            ], 500);
        }
    }
}
