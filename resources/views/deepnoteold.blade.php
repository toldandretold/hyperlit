<div class="container">
            <h1>Main Page</h1>
    <p id="content">This is some text which a new link to a new page will be inserted afterwards. </p>
    <form id="createPageForm" method="POST" action="/create-page">
        <input type="hidden" name="_token" value="7QIMI3Yie91uiWjcxOqCucj5QQEZtYvwnh88fzjK" autocomplete="off">        <button type="submit">Create New Page</button>
    </form>

    <script>
        document.getElementById('createPageForm').addEventListener('submit', function(event) {
            event.preventDefault();

            fetch('/create-page', {
                method: 'POST',
                headers: {
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                }
            }).then(response => response.json()).then(data => {
                if (data.success) {
                    const link = document.createElement('a');
                    link.href = data.url;
                    link.textContent = '<sup>H</sup>';
                    link.id = data.id;

                    const content = document.getElementById('content');
                    content.appendChild(link);
                    
                    // Save the updated content
                    saveUpdatedContent(document.body.innerHTML);
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
    </div>