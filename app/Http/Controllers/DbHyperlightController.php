<?php

namespace App\Http\Controllers;

use App\Models\PgHyperlight;
use App\Models\AnonymousSession;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class DbHyperlightController extends Controller
{
    private function isValidAnonymousToken($token)
    {
        return AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(365))
            ->exists();
    }

    /**
     * Check if user has permission to modify the hyperlight
     * Uses backend-managed auth but keeps individual highlight permission logic
     */
    private function checkHyperlightPermission(Request $request, $creator = null, $creatorToken = null)
    {
        $user = Auth::user();
        
        if ($user) {
            // Logged in user - check they are the creator
            if ($creator && $creator === $user->name) {
                Log::info('Logged-in user hyperlight access granted', [
                    'user' => $user->name,
                    'creator' => $creator
                ]);
                return true;
            }
            
            Log::warning('Logged-in user hyperlight access denied', [
                'user' => $user->name,
                'creator' => $creator,
                'reason' => 'not_creator'
            ]);
            return false;
            
        } else {
            // Anonymous user - check server-managed token from cookie
            $anonymousToken = $request->cookie('anon_token');
            
            if (!$anonymousToken) {
                Log::warning('Anonymous user missing cookie token for hyperlight');
                return false;
            }
            
            // Validate the token exists in our database
            if (!$this->isValidAnonymousToken($anonymousToken)) {
                Log::warning('Anonymous user invalid token for hyperlight', [
                    'token' => $anonymousToken,
                    'reason' => 'token_not_in_database'
                ]);
                return false;
            }
            
            // FIXED: Handle legacy records with null creator_token
            if ($creatorToken === null) {
                // For legacy records without creator_token, allow any valid anonymous user
                // Update last used time for the anonymous session
                AnonymousSession::where('token', $anonymousToken)
                    ->update(['last_used_at' => now()]);
                
                Log::info('Anonymous user hyperlight access granted for legacy record', [
                    'token' => $anonymousToken,
                    'creator_token' => 'null (legacy)',
                    'reason' => 'legacy_record_access'
                ]);
                return true;
            }
            
            if ($creatorToken && $creatorToken === $anonymousToken) {
                // Update last used time for the anonymous session
                AnonymousSession::where('token', $anonymousToken)
                    ->update(['last_used_at' => now()]);
                
                Log::info('Anonymous user hyperlight access granted', [
                    'token' => $anonymousToken,
                    'creator_token' => $creatorToken
                ]);
                return true;
            }
            
            Log::warning('Anonymous user hyperlight access denied', [
                'token' => $anonymousToken,
                'creator_token' => $creatorToken,
                'reason' => 'token_mismatch'
            ]);
            return false;
        }
    }

    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::bulkCreate - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $records = [];
                $user = Auth::user();
                $anonymousToken = $user ? null : $request->cookie('anon_token');
                
                foreach ($data['data'] as $index => $item) {
                    // Backend sets the creator fields based on auth state
                    $creator = $user ? $user->name : null;
                    $creator_token = $user ? null : $anonymousToken;
                    
                    // Check permission using backend-generated auth
                    if (!$this->checkHyperlightPermission(
                        $request, 
                        $creator, 
                        $creator_token
                    )) {
                        Log::warning("Permission denied for hyperlight at index {$index}", [
                            'creator' => $creator,
                            'creator_token' => $creator_token
                        ]);
                        continue; // Skip this item
                    }
                    
                    $record = [
                        'book' => $item['book'] ?? null,
                        'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        'highlightedText' => $item['highlightedText'] ?? null,
                        'highlightedHTML' => $item['highlightedHTML'] ?? null,
                        'annotation' => $item['annotation'] ?? null,
                        'startChar' => $item['startChar'] ?? null,
                        'endChar' => $item['endChar'] ?? null,
                        'startLine' => $item['startLine'] ?? null,
                        'creator' => $creator,
                        'creator_token' => $creator_token,
                        'time_since' => $item['time_since'] ?? floor(time()),
                        'raw_json' => json_encode($this->cleanItemForStorage($item)),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                    
                    $records[] = $record;
                }
                
                if (empty($records)) {
                    return response()->json([
                        'success' => false,
                        'message' => 'No valid records to insert - access denied for all items'
                    ], 403);
                }
                
                PgHyperlight::insert($records);
                
                Log::info('DbHyperlightController::bulkCreate - Success', [
                    'records_inserted' => count($records)
                ]);
                
                return response()->json(['success' => true]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::bulkCreate - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    public function upsert(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::upsert - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0,
                'request_size' => strlen(json_encode($data))
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $processedCount = 0;
                $user = Auth::user();
                $anonymousToken = $user ? null : $request->cookie('anon_token');
                
                foreach ($data['data'] as $index => $item) {
                    // For upserts, we need to check if the record exists first
                    $existingRecord = PgHyperlight::where('book', $item['book'] ?? null)
                        ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                        ->first();
                    
                    if ($existingRecord) {
                        // Check permission against existing record
                        if (!$this->checkHyperlightPermission(
                            $request, 
                            $existingRecord->creator, 
                            $existingRecord->creator_token
                        )) {
                            Log::warning("Permission denied for existing hyperlight update at index {$index}", [
                                'hyperlight_id' => $item['hyperlight_id'] ?? null,
                                'existing_creator' => $existingRecord->creator,
                                'existing_creator_token' => $existingRecord->creator_token
                            ]);
                            continue; // Skip this item
                        }
                        
                        // For existing records, keep the original creator info
                        $creator = $existingRecord->creator;
                        $creator_token = $existingRecord->creator_token;
                    } else {
                        // New record - use backend-generated auth
                        $creator = $user ? $user->name : null;
                        $creator_token = $user ? null : $anonymousToken;
                        
                        // Check permission for new record
                        if (!$this->checkHyperlightPermission(
                            $request, 
                            $creator, 
                            $creator_token
                        )) {
                            Log::warning("Permission denied for new hyperlight at index {$index}", [
                                'creator' => $creator,
                                'creator_token' => $creator_token
                            ]);
                            continue; // Skip this item
                        }
                    }
                    
                    PgHyperlight::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                        ],
                        [
                            'highlightedText' => $item['highlightedText'] ?? null,
                            'highlightedHTML' => $item['highlightedHTML'] ?? null,
                            'annotation' => $item['annotation'] ?? null,
                            'startChar' => $item['startChar'] ?? null,
                            'endChar' => $item['endChar'] ?? null,
                            'startLine' => $item['startLine'] ?? null,
                            'creator' => $creator,
                            'creator_token' => $creator_token,
                            'time_since' => $item['time_since'] ?? floor(time()),
                            'raw_json' => json_encode($this->cleanItemForStorage($item)),
                            'updated_at' => now(),
                        ]
                    );
                    
                    $processedCount++;
                }
                
                Log::info('DbHyperlightController::upsert - Success', [
                    'records_processed' => $processedCount
                ]);
                
                return response()->json([
                    'success' => true, 
                    'message' => 'Hyperlights synced successfully'
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::upsert - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    public function delete(Request $request)
    {
        try {
            $data = $request->all();
            
            Log::info('DbHyperlightController::delete - Received data', [
                'data_count' => isset($data['data']) ? count($data['data']) : 0
            ]);
            
            if (isset($data['data']) && is_array($data['data'])) {
                $deletedCount = 0;
                
                foreach ($data['data'] as $index => $item) {
                    // Find the existing record to check permissions
                    $existingRecord = PgHyperlight::where('book', $item['book'] ?? null)
                        ->where('hyperlight_id', $item['hyperlight_id'] ?? null)
                        ->first();
                    
                    if (!$existingRecord) {
                        Log::warning("Hyperlight not found for deletion at index {$index}", [
                            'book' => $item['book'] ?? null,
                            'hyperlight_id' => $item['hyperlight_id'] ?? null
                        ]);
                        continue;
                    }
                    
                    // Check permission using existing record's creator info
                    if (!$this->checkHyperlightPermission(
                        $request, 
                        $existingRecord->creator, 
                        $existingRecord->creator_token
                    )) {
                        Log::warning("Permission denied for hyperlight deletion at index {$index}", [
                            'hyperlight_id' => $item['hyperlight_id'] ?? null,
                            'creator' => $existingRecord->creator,
                            'creator_token' => $existingRecord->creator_token
                        ]);
                        continue; // Skip this item
                    }
                    
                    $existingRecord->delete();
                    $deletedCount++;
                }
                
                Log::info('DbHyperlightController::delete - Success', [
                    'records_deleted' => $deletedCount
                ]);
                
                return response()->json([
                    'success' => true, 
                    'message' => 'Hyperlights deleted successfully'
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('DbHyperlightController::delete - Exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to delete data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    private function cleanItemForStorage($item)
    {
        // Create a copy to avoid modifying the original
        $cleanItem = $item;
        
        // Remove the raw_json field to prevent recursive nesting
        unset($cleanItem['raw_json']);
        
        // Also remove any other potentially problematic nested fields
        if (isset($cleanItem['full_library_array'])) {
            unset($cleanItem['full_library_array']);
        }
        
        return $cleanItem;
    }
}