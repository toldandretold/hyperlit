
// resources/js/app.js
console.log('App.js is loaded');

//import Editor from '@toast-ui/editor';
//import '@toast-ui/editor/dist/toastui-editor.css';

//document.addEventListener('DOMContentLoaded', function() {
    //const editor = new Editor({
        //el: document.querySelector('#editor'),
        //height: '500px',
        //initialEditType: 'markdown',
        //previewStyle: 'vertical'
    //});
//});

import markdownit from 'markdown-it';

// Initialize Markdown-it
const md = markdownit();

document.addEventListener('DOMContentLoaded', () => {
    const editorit = document.getElementById('markdown-IT-editor');
    const preview = document.getElementById('markdown-it-preview');
    const togglePreviewButton = document.getElementById('toggle-preview');

    if (editorit && preview) {
        // Toggle preview visibility and hide the editor when showing the preview
        togglePreviewButton.addEventListener('click', () => {
            if (preview.style.display === 'none') {
                preview.innerHTML = md.render(editorit.value); // Convert markdown to HTML
                preview.style.display = 'block'; // Show preview
                editorit.style.display = 'none'; // Hide editor (textarea)
                togglePreviewButton.innerText = 'Hide Preview';
            } else {
                preview.style.display = 'none'; // Hide preview
                editorit.style.display = 'block'; // Show editor (textarea)
                togglePreviewButton.innerText = 'Preview';
            }
        });
    }
});



