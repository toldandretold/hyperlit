{{-- Theme before paint for the standalone workbench pages: the reader's storage
     key, so a workbench opens in whatever theme the reader was left in. --}}
<script>
    (function () {
        var t = 'dark';
        try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
        if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
        document.body.classList.add('theme-' + t);
    })();
</script>
