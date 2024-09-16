const mix = require('laravel-mix');

mix.js('resources/js/app.js', 'public/js')
   .sass('resources/sass/app.scss', 'public/css')
   .postCss('resources/css/app.css', 'public/css')
   .version();


mix.js('node_modules/markdown-it/dist/markdown-it.min.js', 'public/js');



