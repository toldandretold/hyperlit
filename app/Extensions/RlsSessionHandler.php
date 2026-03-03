<?php

namespace App\Extensions;

use Illuminate\Session\DatabaseSessionHandler;
use Illuminate\Support\Facades\DB;

class RlsSessionHandler extends DatabaseSessionHandler
{
    /**
     * Read session data using a SECURITY DEFINER function to bypass RLS.
     *
     * StartSession calls read() at the START of its handle() method, before
     * SetDatabaseSessionContext has set app.session_id. Without this override,
     * RLS blocks the read and login doesn't persist.
     *
     * Writes happen at the END of the request (after $next($request) returns),
     * by which point SetDatabaseSessionContext has already set app.session_id,
     * so writes go through normal RLS without issue.
     */
    public function read($sessionId): string|false
    {
        $session = DB::selectOne('SELECT * FROM session_read(?)', [$sessionId]);

        if (!$session) {
            return '';
        }

        if ($this->expired($session)) {
            $this->exists = true;
            return '';
        }

        if (isset($session->payload)) {
            $this->exists = true;
            return base64_decode($session->payload);
        }

        return '';
    }
}
