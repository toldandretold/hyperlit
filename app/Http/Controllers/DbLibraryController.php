<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;

class DbLibraryController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        return $this->handleDatabaseSync(
            $request,
            PgLibrary::class,
            ['book', 'author', 'bibtex', 'citationID', 'fileName', 'fileType',
             'journal', 'note', 'pages', 'publisher', 'school', 'timestamp',
             'title', 'type', 'url', 'year'],
            false // single object
        );
    }
}
