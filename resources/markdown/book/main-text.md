Basics of displaying content
============================

in: 

	Herd/Hyperlit/resources/views

there are .blade.php files.<a href="http://localhost:8000/pages/page-2713098b-2de6-46d1-8606-3f51a9330f41.html" id="page-2713098b-2de6-46d1-8606-3f51a9330f41"><sup>H</sup></a> 

These are the blade templates.

The file name before .blade is used to id the files by laravel.<a href="http://localhost:8000/pages/page-e236b898-35ea-4738-8826-92d6590d12ba.html" id="page-e236b898-35ea-4738-8826-92d6590d12ba"><sup>H</sup></a> 

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

Which indicates that it is an extension of layout.blade.php<a href="http://localhost:8000/pages/page-3ad4c691-ad00-42a3-bdc7-b6e02258a424.html" id="page-3ad4c691-ad00-42a3-bdc7-b6e02258a424"><sup>H</sup></a> 

Testing.<a href="http://localhost:8000/pages/page-1f1abb90-56b6-4c9c-948a-3e05843e2169.html" id="page-1f1abb90-56b6-4c9c-948a-3e05843e2169"><sup>H</sup></a>