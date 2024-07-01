<!-- resources/views/markdown-editor.blade.php -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Editor</title>
    <!-- Include EasyMDE CSS -->
    <link rel="stylesheet" href="{{ asset('css/editor.css') }}">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css">
    
</head>
<body>

    <div class="container">
        <form action="{{ route('markdown.save') }}" method="POST">
            @csrf
            
            <textarea id="markdown-editor" name="markdown">{!! nl2br(e($markdownContent)) !!}</textarea>

            <button type="submit" id="save">Save</button>
        </form>
    </div>



    <!-- Include EasyMDE JS -->
    <script src="https://unpkg.com/easymde/dist/easymde.min.js"></script>

     <script>
            document.addEventListener("DOMContentLoaded", function() {
            var easyMDE = new EasyMDE({
                element: document.getElementById("markdown-editor"),
                autoDownloadFontAwesome: false,
                toolbar: [
                    "bold", "italic", "heading", "|",
                    "quote", "unordered-list", "ordered-list", "|",
                    "link", "image", "|",
                    "preview", "side-by-side", "fullscreen", "|",
                    "guide"
                ]
            });
        });
    </script>
</body>
</html>