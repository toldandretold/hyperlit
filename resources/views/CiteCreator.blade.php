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
form button {
    background-color: #007bff;  /* Primary button color */
    color: white;  /* White text */
    padding: 10px 20px;  /* Padding inside the button */
    border: none;  /* Remove borders */
    border-radius: 4px;  /* Rounded button */
    cursor: pointer;  /* Pointer on hover */
    font-size: 16px;  /* Bigger button text */
}

/* Hover and focus effects */
form button:hover {
    background-color: #0056b3;  /* Darker blue on hover */
}

form input:focus,
form textarea:focus {
    outline: none;  /* Remove default outline */
    border-color: #007bff;  /* Highlight border on focus */
    box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);  /* Slight shadow on focus */
}

/* Validation message styling */
.validation-message {
    font-size: 14px;
    margin-top: 5px;
    margin-bottom: 15px;
    padding: 5px;
    border-radius: 3px;
}

.validation-message.error {
    color: #721c24;
    background-color: #f8d7da;
    border: 1px solid #f5c6cb;
}

.validation-message.success {
    color: #155724;
    background-color: #d4edda;
    border: 1px solid #c3e6cb;
}



</style>

@endsection

@section('content')

    @if ($errors->any())
    <div class="alert alert-danger">
        <ul>
            @foreach ($errors->all() as $error)
                <li>{{ $error }}</li>
            @endforeach
        </ul>
    </div>
    @endif

    <div id="debug-info" style="display: none;"></div>

   <form id="cite-form" action="{{ route('processCite') }}" method="POST" enctype="multipart/form-data">
    @csrf

    <!-- Drag and drop field for Markdown file -->
    <label for="markdown_file">Upload Markdown or EPUB File:</label>
    <input type="file" id="markdown_file" name="markdown_file" accept=".md,.epub,.doc,.docx"><br>
    <div id="file-validation" class="validation-message"></div>

    <!-- Paste BibTeX details -->
    <label for="bibtex">Paste BibTeX Details:</label>
    <textarea id="bibtex" name="bibtex"></textarea><br>

    <!-- BibTeX Type Selection -->
    <label for="type">Type:</label>
    <label><input type="radio" name="type" value="article"> Article</label>
    <label><input type="radio" name="type" value="book"> Book</label>
    <label><input type="radio" name="type" value="phdthesis"> PhD Thesis</label>
    <label><input type="radio" name="type" value="misc"> Miscellaneous</label>
    <br><br>

    <!-- Shared Input Fields -->
    <div id="common-fields">
        <label for="citation_id">Citation ID:</label>
        <input type="text" id="citation_id" name="citation_id"><br>
        <div id="citation_id-validation" class="validation-message"></div>

        <label for="author">Author:</label>
        <input type="text" id="author" name="author"><br>

        <label for="title">Title:</label>
        <input type="text" id="title" name="title"><br>
        <div id="title-validation" class="validation-message"></div>

        <label for="year">Year:</label>
        <input type="number" id="year" name="year"><br>

        <label for="url">URL:</label>
        <input type="text" id="url" name="url"><br>

        <label for="pages" class="optional-field" style="display:none;">Pages:</label>
        <input type="text" id="pages" name="pages" class="optional-field" style="display:none;"><br>

        <label for="journal" class="optional-field" style="display:none;">Journal:</label>
        <input type="text" id="journal" name="journal" class="optional-field" style="display:none;"><br>

        <label for="publisher" class="optional-field" style="display:none;">Publisher:</label>
        <input type="text" id="publisher" name="publisher" class="optional-field" style="display:none;"><br>

        <label for="school" class="optional-field" style="display:none;">School:</label>
        <input type="text" id="school" name="school" class="optional-field" style="display:none;"><br>

        <label for="note" class="optional-field" style="display:none;">Note:</label>
        <input type="text" id="note" name="note" class="optional-field" style="display:none;"><br>
    </div>

    <!-- Form validation summary -->
    <div id="form-validation-summary" style="display: none; background-color: #f8d7da; color: #721c24; padding: 10px; border-radius: 4px; margin-bottom: 20px;">
        <strong>Please fix the following errors:</strong>
        <ul id="validation-list"></ul>
    </div>

    <button type="submit" id="createButton">Create</button>
    <button type="button" id="clearButton">Clear</button>
</form>



@endsection

@section('scripts')

<script>
document.querySelectorAll('input[name="type"]').forEach(radio => {
    radio.addEventListener('change', function() {
        const type = this.value;
        showFieldsForType(type);
        populateFieldsFromBibtex();
    });
});

function showFieldsForType(type) {
    // Hide all optional fields first
    document.querySelectorAll('.optional-field').forEach(field => {
        field.style.display = 'none';
        field.previousElementSibling.style.display = 'none';  // Hide the label
    });

    // Show relevant fields based on the selected type
    if (type === 'article') {
        document.getElementById('journal').style.display = 'block';
        document.querySelector('label[for="journal"]').style.display = 'block';
        document.getElementById('pages').style.display = 'block';  // Show pages field
        document.querySelector('label[for="pages"]').style.display = 'block';
    } else if (type === 'book') {
        document.getElementById('publisher').style.display = 'block';
        document.querySelector('label[for="publisher"]').style.display = 'block';
    } else if (type === 'phdthesis') {
        document.getElementById('school').style.display = 'block';
        document.querySelector('label[for="school"]').style.display = 'block';
    } else if (type === 'misc') {
        document.getElementById('note').style.display = 'block';
        document.querySelector('label[for="note"]').style.display = 'block';
    }
}

function populateFieldsFromBibtex() {
    const bibtexText = document.getElementById('bibtex').value;

    // Use regular expressions to extract fields based on type
    const idMatch = bibtexText.match(/^@\w+\{([^,]+),/);
    const titleMatch = bibtexText.match(/title\s*=\s*{([^}]+)}/);
    const authorMatch = bibtexText.match(/author\s*=\s*{([^}]+)}/);
    const journalMatch = bibtexText.match(/journal\s*=\s*{([^}]+)}/);
    const yearMatch = bibtexText.match(/year\s*=\s*{([^}]+)}/);
    const pagesMatch = bibtexText.match(/pages\s*=\s*{([^}]+)}/);  // Extracting pages
    const publisherMatch = bibtexText.match(/publisher\s*=\s*{([^}]+)}/);
    const schoolMatch = bibtexText.match(/school\s*=\s*{([^}]+)}/);
    const noteMatch = bibtexText.match(/note\s*=\s*{([^}]+)}/);
    const urlMatch = bibtexText.match(/url\s*=\s*{([^}]+)}/);

    // Populate the form fields based on matches
    if (idMatch) document.getElementById('citation_id').value = idMatch[1];  // Set the ID field
    if (titleMatch) document.getElementById('title').value = titleMatch[1];
    if (authorMatch) document.getElementById('author').value = authorMatch[1];
    if (journalMatch && document.getElementById('journal').style.display !== 'none') document.getElementById('journal').value = journalMatch[1];
    if (yearMatch) document.getElementById('year').value = yearMatch[1];
    if (pagesMatch && document.getElementById('pages').style.display !== 'none') document.getElementById('pages').value = pagesMatch[1];  // Set the pages field
    if (publisherMatch && document.getElementById('publisher').style.display !== 'none') document.getElementById('publisher').value = publisherMatch[1];
    if (schoolMatch && document.getElementById('school').style.display !== 'none') document.getElementById('school').value = schoolMatch[1];
    if (noteMatch && document.getElementById('note').style.display !== 'none') document.getElementById('note').value = noteMatch[1];
    if (urlMatch && document.getElementById('url').style.display !== 'none') document.getElementById('url').value = urlMatch[1];
}

document.getElementById('bibtex').addEventListener('input', function() {
    const bibtexText = this.value;
    
    // Match the BibTeX entry type
    const typeMatch = bibtexText.match(/^@\w+/);
    if (typeMatch) {
        const bibType = typeMatch[0].toLowerCase().replace('@', '');
        
        // Auto-select radio button based on BibTeX type
        const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
        if (radio) {
            radio.checked = true;
            showFieldsForType(bibType);
            // Populate the fields immediately after the type is determined
            populateFieldsFromBibtex();
        }
    }
});

document.getElementById('clearButton').addEventListener('click', function() {
    // Clear local storage
    localStorage.removeItem('formData');

    // Clear all form fields
    const form = document.getElementById('cite-form');
    form.reset();

    // Optionally, you can manually clear specific input fields if needed
    form.querySelectorAll('input, textarea').forEach(field => {
        field.value = '';
    });

    // Hide all dynamic form sections if using dynamic form fields like in your previous example
    document.querySelectorAll('.form-section').forEach(section => {
        section.style.display = 'none';
    });

    // Reset the selected radio buttons if applicable
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.checked = false;
    });

     // Refresh the page to fully reset everything
    location.reload(); // This will refresh the page
});

document.getElementById('cite-form').addEventListener('submit', function(event) {
    //event.preventDefault(); // Temporarily uncomment this to test
    
    const fileInput = document.getElementById('markdown_file');
    const debugDiv = document.getElementById('debug-info');
    
    // Debug information
    let debugInfo = 'Form submission debug:\n';
    debugInfo += `File selected: ${fileInput.files.length > 0}\n`;
    
    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        debugInfo += `File name: ${file.name}\n`;
        debugInfo += `File size: ${file.size} bytes\n`;
        debugInfo += `File type: ${file.type}\n`;
    }
    
    // Log form data
    const formData = new FormData(this);
    debugInfo += '\nForm data:\n';
    for (let pair of formData.entries()) {
        debugInfo += `${pair[0]}: ${pair[1]}\n`;
    }
    
    console.log(debugInfo);
    debugDiv.textContent = debugInfo;
    debugDiv.style.display = 'block';
});


document.getElementById('createButton').addEventListener('click', function(event) {
    //event.preventDefault();  // Prevent the default form submission
    const form = document.getElementById('cite-form');

    // Create an object to store form data, replacing empty values with null
    let formDataObj = {};
    const formData = new FormData(form);
    
    formData.forEach((value, key) => {
        // Ensure year is sent as integer and bibtex as text, others as string
        if (key === 'year' && value) {
            formDataObj[key] = parseInt(value) || null; // Parse year as integer
        } else {
            formDataObj[key] = value === '' ? null : value; // Send as text (string) or null
        }
    });

    console.log("Form data being submitted:", formDataObj);

    // Create a new FormData object from the cleaned formDataObj
    const cleanedFormData = new FormData();
    Object.keys(formDataObj).forEach(key => {
        if (formDataObj[key] !== null) {
            cleanedFormData.append(key, formDataObj[key]);
        }
    });

    // Submit the form with cleaned data
    //const actionUrl = form.getAttribute('action');
    //const xhr = new XMLHttpRequest();
    //xhr.open('POST', actionUrl);
    //xhr.setRequestHeader('X-CSRF-TOKEN', document.querySelector('input[name="_token"]').value);
    //xhr.send(cleanedFormData);
});




// Function to save form data to localStorage
function saveFormData() {
    const selectedType = document.querySelector('input[name="type"]:checked');
    const formData = {
        bibtex: document.getElementById('bibtex').value,
        author: document.getElementById('author').value,
        title: document.getElementById('title').value,
        journal: document.getElementById('journal').value,
        publisher: document.getElementById('publisher').value,
        year: document.getElementById('year').value,
        pages: document.getElementById('pages').value,
        ID: document.getElementById('citation_id').value,
        url: document.getElementById('url').value,
        type: selectedType ? selectedType.value : '' // Save selected radio button value
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
        document.getElementById('citation_id').value = formData.ID || '';
        document.getElementById('url').value = formData.url || '';
        document.getElementById('pages').value = formData.pages || '';
        document.getElementById('school').value = formData.school || '';
        document.getElementById('note').value = formData.note || '';

        // Restore the selected radio button
        if (formData.type) {
            const radio = document.querySelector(`input[name="type"][value="${formData.type}"]`);
            if (radio) {
                radio.checked = true; // Set the saved radio button as checked
                showFieldsForType(formData.type); // Display fields for the selected type
            }
        }
    }
}


// Function to clear form data from localStorage
//function clearFormData() {
//    localStorage.removeItem('formData');
//}

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

 // Check if the Laravel session has a success message
    @if(session()->has('success'))
        // Clear form data from localStorage
        clearFormData();
    @endif

    // Define the clearFormData function (previously commented out)
    function clearFormData() {
        localStorage.removeItem('formData');  // Clears the saved form data
    }

</script>


@endsection
