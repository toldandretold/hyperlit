<?php

namespace App\Traits;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\DB;

trait HandlesDatabaseSync
{
    // In your HandlesDatabaseSync trait
    protected function handleDatabaseSync(Request $request, $modelClass, $fields, $isArrayOfObjects = false)
    {
        try {
            $data = $request->all();
            
            if ($isArrayOfObjects && isset($data['data'])) {
                $records = [];
                
                foreach ($data['data'] as $item) {
                    $record = [];
                    
                    // Extract each field from the item
                    foreach ($fields as $field) {
                        $record[$field] = $item[$field] ?? null;
                    }
                    
                    // Add timestamps
                    $record['created_at'] = now();
                    $record['updated_at'] = now();
                    
                    // Store the original data as raw_json
                    $record['raw_json'] = $item;
                    
                    $records[] = $record;
                }
                
                // Bulk insert
                $modelClass::insert($records);
                
                return response()->json(['success' => true]);
            }
            
            // Handle single object case...
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

}
