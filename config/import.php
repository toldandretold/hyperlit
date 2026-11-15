<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Hosts a vault may name a Hyperlit book on
    |--------------------------------------------------------------------------
    |
    | A Markdown / Obsidian vault exported from Hyperlit records each note's
    | original book as a URL (`hyperlit: "https://hyperlit.io/{slug-or-id}"`).
    | When such a folder is dropped back in, App\Services\DocumentImport\
    | VaultBookResolver treats that URL as naming a book in THIS library only
    | when its host is listed here (the app's own APP_URL host is always
    | accepted). Listing the production host lets a vault downloaded from prod
    | resolve on a dev or staging copy of the same library.
    |
    */

    'vault_hosts' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('VAULT_IMPORT_HOSTS', 'hyperlit.io,www.hyperlit.io'))
    ))),

];
