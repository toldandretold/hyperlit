const mix = require('laravel-mix');

// Global JavaScript
mix.js('resources/js/app.js', 'public/js')
   .version(); // For cache busting

// Lazy loading logic (shared across templates)
mix.js('resources/js/lazy-loading.js', 'public/js')
   .version(); // For cache busting

// Template-specific JavaScript
mix.js('resources/js/div-editor.js', 'public/js') // For editable div template
   .version();

mix.js('resources/js/reader.js', 'public/js') // For reader template
   .version();

// Optional: Compile styles if needed (update paths as per your project)
mix.sass('resources/sass/app.scss', 'public/css')
   .postCss('resources/css/app.css', 'public/css')
   .version();
