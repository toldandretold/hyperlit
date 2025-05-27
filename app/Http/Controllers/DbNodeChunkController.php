<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;

class DbNodeChunkController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        return $this->handleDatabaseSync(
            $request,
            PgNodeChunk::class,
            ['book', 'chunk_id', 'startLine', 'content', 'footnotes', 
             'hypercites', 'hyperlights', 'plainText', 'type'],
             true // array of objects
        );
    }
}
