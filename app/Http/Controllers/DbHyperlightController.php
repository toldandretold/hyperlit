<?php

namespace App\Http\Controllers;

use App\Models\PgHyperlight;
use App\Traits\HandlesDatabaseSync;
use Illuminate\Http\Request;

class DbHyperlightController extends Controller
{
    use HandlesDatabaseSync;

    public function bulkCreate(Request $request)
    {
        return $this->handleDatabaseSync(
            $request,
            PgHyperlight::class,
            ['book', 'hyperlight_id', 'annotation', 'endChar', 'highlightedHTML',
             'highlightedText', 'startChar', 'startLine'],
             true // array of objects
        );
    }
}
