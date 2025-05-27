<?php

namespace App\Http\Controllers;

use App\Models\PgHypercite;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;

class DbHyperciteController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        return $this->handleDatabaseSync(
            $request,
            PgHypercite::class,
            ['book', 'hyperciteId', 'citedIN', 'endChar', 'hypercitedHTML',
             'hypercitedText', 'relationshipStatus', 'startChar'],
             true // array of objects
        );
    }
}
