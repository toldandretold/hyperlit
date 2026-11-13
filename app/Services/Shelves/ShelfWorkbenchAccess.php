<?php

namespace App\Services\Shelves;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * "May this person run workbench tools on this shelf?" — ONE definition.
 *
 * Asked by the API gate (RequireShelfOwner), the page route (/a/{slug}/hypercites) and the
 * archive panel's `canCurate` flag, so the button, the page and the endpoints can never
 * disagree about who is allowed.
 *
 * The rule: you are the shelf's creator; the shelf is PUBLIC (the tools mint public links
 * and the page hangs off the shelf's public archive); and it is an ordinary user shelf —
 * not a system-membership kind (likes, licence review), whose contents the owner does not
 * choose. Being an admin grants nothing here: an admin curating someone else's shelf uses
 * the operator console (/maintainer/hypercites), which has no ownership rule to satisfy.
 */
class ShelfWorkbenchAccess
{
    /** The shelf row when $user may curate it, else null. */
    public function curatableShelf(string $shelfId, ?User $user): ?object
    {
        if (! $user || ! Str::isUuid($shelfId)) {
            return null;
        }

        // pgsql_admin + explicit predicates: `shelves` is RLS'd, and this must give the
        // same answer whatever session vars the request happens to carry.
        $shelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $shelfId)
            ->where('creator', $user->name)
            ->where('visibility', 'public')
            ->first(['id', 'name', 'slug', 'creator', 'visibility', 'kind']);

        return $shelf && ! ShelfKinds::isSystem($shelf) ? $shelf : null;
    }

    public function canCurate(string $shelfId, ?User $user): bool
    {
        return $this->curatableShelf($shelfId, $user) !== null;
    }
}
