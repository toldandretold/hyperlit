@extends('layout')

@section('styles')

    <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css">
    <link rel="stylesheet" href="/css/toast_reader.css" />
@endsection

@section('content')
    <div id="editor"></div>
@endsection

@section('scripts')
    <script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"></script>
    <script>


        document.addEventListener('DOMContentLoaded', function() {

                // Define custom save button
                const saveButton = document.createElement('button');
                saveButton.textContent = 'Save';
                saveButton.id = 'saveButton';  // Assign an ID to the button
                saveButton.style.cursor = 'pointer';
                saveButton.addEventListener('click', () => {
                  const content = editor.getMarkdown();
                  // Add your save logic here
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
                    if (!data.success) {
                          alert('Failed to save content.');
                        }
                    console.log('Content saved:', content);
                  });
                });

            const options = {
                el: document.querySelector('#editor'),
                      height: '100vh',
                      initialEditType: 'markdown',
                      previewStyle: 'tab',
                      hideModeSwitch: true,
                      initialValue: '',
                      toolbarItems: [
                            ['heading', 'bold', 'italic', 'quote'],
                            ['table', 'image', 'link'],
                            ['scrollSync'],
                            [{
                                name: 'save',
                                tooltip: 'Save',
                                el: saveButton

                            }]
                          ]

                    };

                    // Initialize the editor with the options
                    const editor = new toastui.Editor(options);

            

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

            
        });
    </script>
@endsection
