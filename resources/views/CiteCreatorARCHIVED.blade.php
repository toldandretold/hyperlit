@extends('layout')

@section('styles')
     <link rel="stylesheet" href="{{ asset('css/reader.css') }}"> 
<style type="text/css">
    
    /* Style the form container */
form {
    max-width: 600px;  /* Limit the form width */
    margin: 0 auto;    /* Center the form horizontally */
    padding: 20px;
    background-color: #f7f7f7;  /* Light background for better readability */
    border-radius: 8px;  /* Rounded corners */
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);  /* Add a subtle shadow */
}

/* Label styling */
form label {
    font-weight: bold;
    display: block;  /* Make labels appear above input fields */
    margin-bottom: 8px;  /* Add space between label and input */
    color: #333;  /* Slightly darker text */
}

/* Input and textarea styling */
form input[type="text"],
form input[type="file"],
form input[type="number"],
form input[type="url"],
form textarea {
    width: 100%;  /* Full width */
    padding: 10px;  /* Add padding for better touch targets */
    margin-bottom: 20px;  /* Space between fields */
    border: 1px solid #ccc;  /* Border styling */
    border-radius: 4px;  /* Rounded input fields */
    font-size: 16px;  /* Slightly larger text */
    box-sizing: border-box;  /* Ensure padding doesn't affect total width */
}

/* Textarea specific styling */
form textarea {
    height: 150px;  /* Bigger height for text area */
    resize: vertical;  /* Allow vertical resizing */
}

/* Submit button styling */
form button[type="submit"] {
    background-color: #007bff;  /* Primary button color */
    color: white;  /* White text */
    padding: 10px 20px;  /* Padding inside the button */
    border: none;  /* Remove borders */
    border-radius: 4px;  /* Rounded button */
    cursor: pointer;  /* Pointer on hover */
    font-size: 16px;  /* Bigger button text */
}

/* Hover and focus effects */
form button[type="submit"]:hover {
    background-color: #0056b3;  /* Darker blue on hover */
}

form input:focus,
form textarea:focus {
    outline: none;  /* Remove default outline */
    border-color: #007bff;  /* Highlight border on focus */
    box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);  /* Slight shadow on focus */
}



</style>

@endsection

@section('content')

   <form id="cite-form" action="{{ route('processCite') }}" method="POST" enctype="multipart/form-data">

    @csrf

    <!-- Drag and drop field for Markdown file -->
    <label for="markdown_file">Upload Markdown File:</label>
    <input type="file" id="markdown_file" name="markdown_file" accept=".md"><br>


    <!-- Paste BibTeX details -->
    <label for="bibtex">Paste BibTeX Details:</label>
    <textarea id="bibtex" name="bibtex"></textarea><br>

    <!-- BibTeX details -->
    <label for="type">Type:</label>
    <label>
    <input type="radio" id="radio" name="type" value="Journal"> Journal
    </label><br>
    <label>
    <input type="radio" id="radio" name="type" value="Book"> Book
    </label><br>
    <label>
    <input type="radio" id="radio" name="type" value="Website"> Website
    </label><br>
     <label>
    <input type="radio" id="radio" name="type" value="Miscellaneous"> Miscellaneous
    </label><br>


    <label for="author">Author:</label>
    <input type="text" id="author" name="author"><br>

    <label for="title">Title:</label>
    <input type="text" id="title" name="title"><br>

    <label for="journal">Journal:</label>
    <input type="text" id="journal" name="journal"><br>

    <label for="publisher">Publisher:</label>
    <input type="text" id="publisher" name="publisher"><br>

    <label for="year">Year:</label>
    <input type="number" id="year" name="year"><br>

    <label for="url">URL:</label>
    <input type="url" id="url" name="url"><br>

    <label for="pages">Page Numbers</label>
    <input type="text" id="pages" name="page"><br>

    

    <button type="submit">Create</button>
</form>


@endsection

@section('scripts')

<script>
document.getElementById('bibtex').addEventListener('input', function() {
    const bibtexText = this.value;
    
    // Use regular expressions to extract BibTeX fields
    const titleMatch = bibtexText.match(/title\s*=\s*{([^}]+)}/);
    const authorMatch = bibtexText.match(/author\s*=\s*{([^}]+)}/);
    const journalMatch = bibtexText.match(/journal\s*=\s*{([^}]+)}/);
    const pagesMatch = bibtexText.match(/pages\s*=\s*{([^}]+)}/);
    const yearMatch = bibtexText.match(/year\s*=\s*{([^}]+)}/);
    const publisherMatch = bibtexText.match(/publisher\s*=\s*{([^}]+)}/);

    // Populate the form fields
    if (titleMatch) {
        document.getElementById('title').value = titleMatch[1];
    }
    if (authorMatch) {
        document.getElementById('author').value = authorMatch[1];
    }
    if (journalMatch) {
        document.getElementById('journal').value = journalMatch[1];
    }
    if (pagesMatch) {
        document.getElementById('pages').value = pagesMatch[1];
    }
    if (yearMatch) {
        document.getElementById('year').value = yearMatch[1];
    }
    if (publisherMatch) {
        document.getElementById('publisher').value = publisherMatch[1];
    }
});

// Function to save form data to localStorage
function saveFormData() {
    const formData = {
        bibtex: document.getElementById('bibtex').value,
        author: document.getElementById('author').value,
        title: document.getElementById('title').value,
        journal: document.getElementById('journal').value,
        publisher: document.getElementById('publisher').value,
        year: document.getElementById('year').value,
        pages: document.getElementById('pages').value,
    };
    localStorage.setItem('formData', JSON.stringify(formData));
}

// Function to load form data from localStorage
function loadFormData() {
    const savedData = localStorage.getItem('formData');
    if (savedData) {
        const formData = JSON.parse(savedData);
        document.getElementById('bibtex').value = formData.bibtex || '';
        document.getElementById('author').value = formData.author || '';
        document.getElementById('title').value = formData.title || '';
        document.getElementById('journal').value = formData.journal || '';
        document.getElementById('publisher').value = formData.publisher || '';
        document.getElementById('year').value = formData.year || '';
        document.getElementById('pages').value = formData.pages || '';
    }
}

// Function to clear form data from localStorage
function clearFormData() {
    localStorage.removeItem('formData');
}

// Event listeners to save data on input
document.getElementById('cite-form').addEventListener('input', saveFormData);

// Load data on page load
window.addEventListener('load', loadFormData);

// Clear localStorage on form submit
document.getElementById('cite-form').addEventListener('submit', function() {
    clearFormData();
});

// Real-time form validation
document.querySelectorAll('input[type="text"], textarea').forEach((input) => {
    input.addEventListener('input', function() {
        if (this.value === '') {
            this.style.borderColor = 'red'; // Invalid input
        } else {
            this.style.borderColor = 'green'; // Valid input
        }
    });
});
</script>


@endsection
