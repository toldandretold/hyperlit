<?php

namespace App\Traits;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Http\Request;

trait HandlesDatabaseSync
{
    protected function handleDatabaseSync(Request $request, string $model, array $fields, bool $isArrayData = true)
    {
        try {
            DB::beginTransaction();

            $book = $request->input('book');
            $data = $request->input('data');

            // Log the exact data we're working with
            Log::info('Starting database sync:', [
                'model' => $model,
                'book' => $book,
                'data_sample' => is_array($data) ? 'Array with ' . count($data) . ' items' : 'Single object'
            ]);

            // Delete existing records for this book
            $deleteCount = $model::where('book', $book)->delete();
            Log::info('Deleted existing records:', ['count' => $deleteCount]);

            if (!$isArrayData) {
                // For footnotes, we want to store the entire array in the data field
                $recordData = [
                    'book' => $book,
                    'data' => $data,
                    'raw_json' => $data
                ];

                Log::info('Creating footnote record:', [
                    'book' => $book,
                    'data_count' => is_array($data) ? count($data) : 'not array',
                ]);

                $record = $model::create($recordData);
                Log::info('Created record:', ['id' => $record->book]);
                
                $count = 1;
            } else {
                $count = 0;
                foreach ((array)$data as $item) {
                    $recordData = array_merge(
                        array_intersect_key($item, array_flip($fields)),
                        ['book' => $book, 'raw_json' => $item]
                    );
                    $model::create($recordData);
                    $count++;
                }
            }

            DB::commit();
            Log::info('Database sync completed successfully', [
                'model' => $model,
                'count' => $count
            ]);

            return response()->json([
                'success' => true,
                'message' => "Successfully synced {$book} data to database",
                'count' => $count
            ]);
        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Database sync error:', [
                'message' => $e->getMessage(),
                'model' => $model,
                'book' => $book ?? 'unknown'
            ]);
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
                'debug_info' => [
                    'trace' => $e->getTraceAsString()
                ]
            ], 500);
        }
    }
}
