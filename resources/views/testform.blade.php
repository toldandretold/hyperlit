<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Test Form</title>
</head>
<body>
    <form method="POST" action="/save-highlight">
        @csrf
        <label for="text">Highlight Text:</label>
        <input type="text" name="text" value="Test highlight">
        
        <label for="id">Highlight ID:</label>
        <input type="text" name="id" value="test_id_123">
        
        <label for="numerical">Numerical:</label>
        <input type="number" name="numerical" value="123">
        
        <button type="submit">Submit</button>
    </form>
</body>
</html>
