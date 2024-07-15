<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Main Page</title>
    <link rel="stylesheet" href="https://uicdn.toast.com/tui-editor/latest/tui-editor.css">
    <link rel="stylesheet" href="https://uicdn.toast.com/tui-editor/latest/tui-editor-contents.css">
    <script src="https://uicdn.toast.com/tui-editor/latest/tui-editor-Editor-full.min.js"></script>
</head>
<body>
    <h1>Main Page</h1>
    <div id="editor"></div>
    <form id="createPageForm" method="POST" action="/create-page">
        @csrf
        <button type="submit">Create New Page</button>
    </form>

    <script>
        // Initialize the Toast UI Editor
        const editor = new toastui.Editor({
            el: document.querySelector('#editor'),
            height: '400px',
            initialEditType: 'markdown',
            previewStyle: 'vertical'
        });

        document.getElementById('createPageForm').addEventListener('submit', function(event) {
            event.preventDefault();

            fetch('/create-page', {
                method: 'POST',
                headers: {
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                }
            }).then(response => response.json()).then(data => {
                if (data.success) {
                    const linkText = ' [I am a new link created within the body of markdown code to a new page](' + data.url + ') ';
                    const cursorPosition = editor.getCurrentRange().from;

                    // Insert link at cursor position
                    editor.insertText(linkText, cursorPosition);

                    // Save the updated content
                    saveUpdatedContent(editor.getMarkdown());
                } else {
                    alert('Error creating page');
                }
            });
        });

        function saveUpdatedContent(updatedContent) {
            fetch('/save-content', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({ content: updatedContent })
            }).then(response => response.json()).then(data => {
                if (!data.success) {
                    alert('Error saving updated content');
                }
            });
        }
    </script>
</body>
</html>
