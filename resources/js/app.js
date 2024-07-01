
// resources/js/app.js
console.log('App.js is loaded');

import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';

document.addEventListener('DOMContentLoaded', function() {
    const editor = new Editor({
        el: document.querySelector('#editor'),
        height: '500px',
        initialEditType: 'markdown',
        previewStyle: 'vertical'
    });
});