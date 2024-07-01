<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Editor</title>
    <!-- Include SimpleMDE CSS -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/simplemde/latest/simplemde.min.css">

  
    <style>
        html, body {
            height: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: #fff; /* Default background color */
            transition: background-color 0.3s ease;
            border: none;
        }

        .SimpleMDE-container {
            position: relative;
            height: 100vh; /* Make container take full viewport height */
        }
        .container {
            display: flex;
            flex-direction: column;
            height: 100%;
            border: none;
        }
        .editor-toolbar {
            z-index: 10;
            background-color: #fff;
            border-bottom: none; /* Remove bottom border */
            box-shadow: none; /* Remove shadow */
            border: none;

        }
        #editor-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
            border: none;
        }
        #markdown-editor {
            flex: 1;
            height: 100%;
            width: 100%;
        }
        
        .CodeMirror {
            height: calc(100vh - 50px); /* Adjust height based on toolbar */
            overflow-y: auto; /* Enable scrolling within the editor */
        }

        
        .editor-statusbar {
            display: none;
        }

        .custom-icon {
    
            display: inline-block;
            background-size: contain;
            background-repeat: no-repeat;
            background-position: center; /* Center the icon */
            vertical-align: bottom; /* Align vertically with other icons */
            background-image: url('/images/logo.png') !important; /* Path to your logo image */
    
        }


        .custom-superscript-icon {
            background-image: url('/images/logo.png'); /* Path to your logo image */
        }
        

         /* Ensure the custom icon is visible in both editing and preview modes */
        .editor-toolbar .custom-icon.custom-superscript-icon,
        .editor-toolbar .custom-icon.custom-superscript-icon:hover,
        .editor-toolbar .custom-icon.custom-superscript-icon:active,
        .editor-toolbar .custom-icon.custom-superscript-icon:focus,
        .editor-toolbar .custom-icon.custom-superscript-icon:disabled {
            background-image: url('/images/logo.png') !important;
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;

        }


    </style>
</head>
<body>
    <div class="container">
        <form id="markdown-form" action="{{ route('markdown.save') }}" method="POST">
            @csrf
            <div class="editor-toolbar"></div>
            <div id="editor-container">
            </div>
        </form>
    </div>

    <!-- Include SimpleMDE JS -->
    <script src="https://cdn.jsdelivr.net/simplemde/latest/simplemde.min.js"></script>
    <script>
        document.addEventListener("DOMContentLoaded", function() {

            // Define save button action
            function saveMarkdown() {
                document.getElementById("markdown-form").submit();
            }

            // Define custom button action
            function customFunction(editor) {
                // Example: Insert custom text at the cursor position
                var cm = editor.codemirror;
                var doc = cm.getDoc();
                var cursor = doc.getCursor(); // Gets the line number in the cursor position
                var line = doc.getLine(cursor.line); // Gets the whole line
                var pos = {
                    line: cursor.line
                };
                doc.replaceRange("[<sup>H</sup>](http://)", pos); // Adds a custom text
            }

            var simplemde = new SimpleMDE({
                element: document.getElementById("markdown-editor"),
                toolbar: [
                    "bold", "italic", "heading", 
                    {
                        name: "custom",
                        action: customFunction,
                        className: "custom-icon custom-superscript-icon", // Custom icon class
                        title: "Custom Button",
                        },
                    "link", "preview", "side-by-side",
                    {
                        name: "save",
                        action: saveMarkdown,
                        className: "fa fa-save",
                        title: "Save",
                    },
                ]

            });

            

            // Adjust the height of the editor to fit within the viewport
            function adjustEditorHeight() {
                var toolbarHeight = document.querySelector(".editor-toolbar").offsetHeight;
                var statusBarHeight = document.querySelector(".editor-statusbar").offsetHeight;
                var editorContainer = document.getElementById("editor-container");
                editorContainer.style.height = `calc(100vh - ${toolbarHeight}px - ${statusBarHeight}px)`;
                simplemde.codemirror.refresh();
            }

            // Call adjustEditorHeight on load and on window resize
            adjustEditorHeight();
            window.addEventListener("resize", adjustEditorHeight);

            

        });
    </script>
</body>
</html>
