<?php

namespace App\Http\Controllers;

use App\Models\PgFootnote;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class DbFootnoteController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        Log::info('Footnote data received:', [
            'book' => $request->input('book'),
            'data_sample' => array_slice($request->input('data'), 0, 2) // Log first 2 items as sample
        ]);

        return $this->handleDatabaseSync(
            $request,
            PgFootnote::class,
            ['book', 'data'],
            false // Change to false since we want to store the entire array as one JSON object
        );
    }
}
