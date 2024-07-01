
Basics of displaying content
----------------------------

in: 

	Herd/Hyperlit/resources/views

there are .blade.php files.

These are the blade templates.

The file name before .blade is used to id the files by laravel.

For example, I currently have layout.blade.laravel as the basic template of the site. This contains

	 <div class="container">
        @yield('content')
    </div>

I also have markdown.blade.php

This contains 

	@extends('layout')
	
	@section('content')
    <?php use League\CommonMark\CommonMarkConverter;

    $filePath = resource_path('markdown/Need_to_do.md');
    $markdown = file_get_contents($filePath);

    $converter = new CommonMarkConverter();
    $html = $converter->convertToHtml($markdown);
    ?>

    {!! $html !!}

	@endsection

Laravel knows how to combine these two documents because in the /Herd/Hyperlit/routes/web.php there is:

		Route::get('/', function () {
	    return view('markdown');
	});

Where 'markdown' refers to markdown.blade.php, a file that has at the top

	@extends('layout')

Which indicates that it is an extension of layout.blade.php

