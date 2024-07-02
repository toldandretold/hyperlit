@extends('layout')

@section('styles')
    <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css">
    <link rel="stylesheet" href="/css/toast_reader.css" />
@endsection

@section('content')
    <div id="editor"></div>
    <button id="togglePreview">Toggle Preview</button>
    <button id="saveButton">Save</button>
@endsection

@section('scripts')
    <script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const Editor = toastui.Editor;

            // Initialize the editor without initial content
            const editor = new Editor({
                el: document.querySelector('#editor'),
                height: '100vh',
                initialEditType: 'markdown',
                previewStyle: 'vertical',
                initialValue: ''
            });

            // Fetch markdown content via AJAX
            fetch('{{ route("getMarkdown") }}')
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Network response was not ok ' + response.statusText);
                    }
                    return response.json();
                })
                .then(data => {
                    editor.setMarkdown(data.content);
                })
                .catch(error => console.error('Error fetching markdown content:', error));

            // Toggle preview pane
            document.getElementById('togglePreview').addEventListener('click', function() {
                const currentPreviewStyle = editor.getCurrentPreviewStyle();
                editor.changePreviewStyle(currentPreviewStyle === 'none' ? 'vertical' : 'none');
            });

            // Save the content to the server
            document.getElementById('saveButton').addEventListener('click', function() {
                const content = editor.getMarkdown();
                fetch('{{ route("saveMarkdown") }}', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': '{{ csrf_token() }}'
                    },
                    body: JSON.stringify({ markdown: content })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert('Content saved successfully!');
                    } else {
                        alert('Failed to save content.');
                    }
                });
            });
        });
    </script>
@endsection
