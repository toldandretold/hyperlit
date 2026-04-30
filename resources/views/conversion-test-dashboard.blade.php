<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Conversion Pipeline — Test Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #221F20; color: #CBCCCC;
            font-family: "Courier New", Courier, monospace;
            font-size: 13px; padding: 24px;
        }
        h1 { color: #4EACAE; font-size: 20px; margin-bottom: 8px; }
        h2 { color: #EF8D34; font-size: 16px; margin: 24px 0 12px; }
        h3 { color: #4EACAE; font-size: 14px; margin: 16px 0 8px; }

        .header-row {
            display: flex; align-items: center; gap: 16px; margin-bottom: 20px;
        }
        .btn {
            background: rgba(75, 75, 75, 0.6); color: #CBCCCC; border: none;
            padding: 0.75em 1em; border-radius: 0.5em; cursor: pointer;
            font-family: inherit; font-size: 13px; font-weight: bold;
            transition: all 0.2s ease;
        }
        .btn:hover { background: rgba(95, 95, 95, 0.8); }
        .btn:disabled { opacity: 0.5; cursor: wait; }
        .btn.active, .btn-primary {
            background: #4EACAE; color: #221F20;
        }
        .btn-primary:hover { background: #3d8a8c; color: #221F20; }
        .btn.fail { background: rgba(239,68,68,0.6); color: #fff; }

        .summary {
            display: flex; gap: 12px; margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .summary-card {
            background: rgba(75, 75, 75, 0.3);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            border-radius: 0.5em;
            padding: 12px 16px; min-width: 140px;
        }
        .summary-card .label {
            color: rgba(203,204,204,0.5); font-size: 11px;
            text-transform: uppercase; letter-spacing: 0.05em;
        }
        .summary-card .value { font-size: 22px; font-weight: bold; margin-top: 4px; }
        .summary-card .value.pass { color: #22c55e; }
        .summary-card .value.fail { color: #ef4444; }
        .summary-card .value.warn { color: #EF8D34; }

        table {
            width: 100%; border-collapse: collapse;
            background: rgba(75, 75, 75, 0.15); border-radius: 0.5em;
            overflow: hidden;
        }
        th {
            text-align: left; padding: 8px 12px;
            background: rgba(75, 75, 75, 0.3);
            color: rgba(203,204,204,0.5);
            font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
        }
        td { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.05); }
        tr:hover td { background: rgba(75, 75, 75, 0.2); }

        .badge {
            display: inline-block; padding: 2px 8px; border-radius: 4px;
            font-size: 11px; font-weight: bold;
        }
        .badge.pass { background: rgba(34,197,94,0.2); color: #22c55e; }
        .badge.fail { background: rgba(239,68,68,0.2); color: #ef4444; }
        .badge.pending { background: rgba(75,75,75,0.4); color: rgba(203,204,204,0.5); }
        .badge.full { background: rgba(78,172,174,0.15); color: #4EACAE; }
        .badge.html { background: rgba(239,141,52,0.15); color: #EF8D34; }
        .badge.covered { background: rgba(34,197,94,0.15); color: #22c55e; }
        .badge.uncovered { background: rgba(239,68,68,0.15); color: #ef4444; }
        .badge.public { background: rgba(78,172,174,0.15); color: #4EACAE; }
        .badge.consented { background: rgba(239,141,52,0.15); color: #EF8D34; }

        .coverage-grid {
            display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;
        }

        .checks { font-size: 12px; color: rgba(203,204,204,0.7); }
        .checks .check-pass { color: #22c55e; }
        .checks .check-fail { color: #ef4444; }

        .spinner {
            display: inline-block; width: 14px; height: 14px;
            border: 2px solid rgba(255,255,255,0.2);
            border-top-color: #4EACAE; border-radius: 50%;
            animation: spin 0.6s linear infinite; vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .muted { color: rgba(203,204,204,0.4); }

        /* Drop zone */
        .drop-zone {
            border: 2px dashed rgba(78,172,174,0.3);
            border-radius: 0.5em;
            padding: 24px;
            text-align: center;
            color: rgba(203,204,204,0.5);
            transition: all 0.2s ease;
            margin-bottom: 16px;
            background: rgba(75, 75, 75, 0.1);
        }
        .drop-zone.drag-over {
            border-color: #4EACAE;
            background: rgba(78,172,174,0.1);
            color: #4EACAE;
        }
        .drop-zone p { margin-bottom: 8px; }
        .drop-zone .drop-hint { font-size: 11px; }
        .drop-zone .file-input-label {
            color: #4EACAE; cursor: pointer;
            text-decoration: underline;
        }
        .drop-zone .file-input-label:hover { color: #3d8a8c; }

        /* Upload form */
        .upload-form {
            display: none;
            background: rgba(75, 75, 75, 0.2);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            border-radius: 0.5em;
            padding: 16px;
            margin-bottom: 16px;
        }
        .upload-form.visible { display: block; }
        .upload-form .field { margin-bottom: 12px; }
        .upload-form label {
            display: block; font-size: 11px; text-transform: uppercase;
            color: rgba(203,204,204,0.5); letter-spacing: 0.05em;
            margin-bottom: 4px;
        }
        .upload-form input[type="text"] {
            width: 100%; max-width: 400px;
            background: rgba(75, 75, 75, 0.4); border: 1px solid rgba(255,255,255,0.1);
            color: #CBCCCC; padding: 8px 10px; border-radius: 4px;
            font-family: inherit; font-size: 13px;
        }
        .upload-form input[type="text"]:focus {
            outline: none; border-color: #4EACAE;
        }
        .upload-form .file-list {
            font-size: 12px; color: rgba(203,204,204,0.7);
            margin-bottom: 8px;
        }
        .upload-form .file-list span { color: #4EACAE; }
        .upload-form .btn-row {
            display: flex; gap: 8px; align-items: center;
        }
    </style>
</head>
<body>
    <div class="header-row">
        <h1>Conversion Pipeline Tests</h1>
        <button class="btn btn-primary" id="runBtn" onclick="runTests()">Run All Tests</button>
        <span id="runStatus"></span>
    </div>

    {{-- Summary cards --}}
    <div class="summary" id="summaryCards">
        <div class="summary-card">
            <div class="label">Fixtures</div>
            <div class="value">{{ count($fixtures) }}</div>
        </div>
        <div class="summary-card">
            <div class="label">Result</div>
            <div class="value pending" id="summaryResult">—</div>
        </div>
        <div class="summary-card">
            <div class="label">Strategies Covered</div>
            <div class="value {{ count($uncoveredStrategies) > 0 ? 'warn' : 'pass' }}">
                {{ count($coveredStrategies) }}/{{ count($knownStrategies) }}
            </div>
        </div>
        <div class="summary-card">
            <div class="label">Styles Covered</div>
            <div class="value {{ count($uncoveredStyles) > 0 ? 'warn' : 'pass' }}">
                {{ count($coveredStyles) }}/{{ count($knownStyles) }}
            </div>
        </div>
    </div>

    {{-- Coverage gaps --}}
    <h2>Coverage</h2>

    <h3>Footnote Strategies</h3>
    <div class="coverage-grid">
        @foreach($knownStrategies as $s)
            <span class="badge {{ in_array($s, $coveredStrategies) ? 'covered' : 'uncovered' }}">
                {{ $s }}
            </span>
        @endforeach
    </div>

    <h3>Citation Styles</h3>
    <div class="coverage-grid">
        @foreach($knownStyles as $s)
            <span class="badge {{ in_array($s, $coveredStyles) ? 'covered' : 'uncovered' }}">
                {{ $s }}
            </span>
        @endforeach
    </div>

    {{-- Fixtures table --}}
    <h2>Fixtures</h2>
    <table id="fixturesTable">
        <thead>
            <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Citation Style</th>
                <th>Footnote Strategy</th>
                <th>Pipeline</th>
                <th>Expected</th>
                <th>Result</th>
                <th>Details</th>
            </tr>
        </thead>
        <tbody>
            @foreach($fixtures as $f)
            <tr data-fixture="{{ $f['dir_name'] }}">
                <td>{{ $f['dir_name'] }}</td>
                <td>{{ $f['description'] ?? '' }}</td>
                <td><span class="badge">{{ $f['citation_style'] ?? '?' }}</span></td>
                <td><span class="badge">{{ $f['footnote_strategy'] ?? '?' }}</span></td>
                <td><span class="badge {{ $f['pipeline'] === 'full' ? 'full' : 'html' }}">{{ $f['pipeline'] }}</span></td>
                <td>
                    {{ $f['expected']['references_count'] ?? 0 }} refs,
                    {{ $f['expected']['citations_linked'] ?? 0 }}/{{ $f['expected']['citations_total'] ?? 0 }} cites,
                    {{ $f['expected']['footnotes_count'] ?? 0 }} fn
                </td>
                <td class="result-cell"><span class="badge pending">pending</span></td>
                <td class="checks"></td>
            </tr>
            @endforeach
        </tbody>
    </table>

    {{-- Upload fixture via drag-and-drop --}}
    <h2>Add Fixture</h2>

    <div class="drop-zone" id="dropZone">
        <p>Drop <strong>ocr_response.json</strong> or <strong>debug_converted.html</strong> here</p>
        <p class="drop-hint">
            or <label class="file-input-label" for="fileInput">browse files</label>
            — accepts ocr_response.json, debug_converted.html, footnote_meta.json
        </p>
        <input type="file" id="fileInput" multiple accept=".json,.html,.md" style="display: none;">
    </div>

    <div class="upload-form" id="uploadForm">
        <div class="file-list" id="fileList"></div>
        <div class="field">
            <label for="fixtureName">Fixture Name</label>
            <input type="text" id="fixtureName" placeholder="e.g. sequential_endnotes_example" pattern="[a-zA-Z0-9_-]+">
        </div>
        <div class="field">
            <label for="fixtureDesc">Description</label>
            <input type="text" id="fixtureDesc" placeholder="e.g. Chapter endnotes with numbered citations">
        </div>
        <div class="btn-row">
            <button class="btn btn-primary" id="uploadBtn" onclick="submitUpload()">Create Fixture</button>
            <button class="btn" onclick="cancelUpload()">Cancel</button>
            <span id="uploadStatus"></span>
        </div>
    </div>

    {{-- Coverage gap suggestions --}}
    @if(count($suggestions) > 0)
    <h2>Fill Coverage Gaps</h2>
    <p class="muted" style="margin-bottom: 8px;">
        Books that would fill an uncovered strategy. Click to add as fixture.
    </p>
    <table>
        <thead>
            <tr>
                <th>Uncovered Strategy</th>
                <th>Candidate Book</th>
                <th>OCR Classification</th>
                <th>Source</th>
                <th>Submitted By</th>
                <th>Rating</th>
                <th></th>
            </tr>
        </thead>
        <tbody>
            @foreach($suggestions as $s)
            <tr id="suggestion-{{ $loop->index }}">
                <td><span class="badge uncovered">{{ $s['strategy'] }}</span></td>
                <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis;" title="{{ $s['book_id'] }}">{{ $s['book_id'] }}</td>
                <td>{{ $s['classification'] }}</td>
                <td><span class="badge {{ $s['source'] }}">{{ $s['source'] }}</span></td>
                <td>{{ $s['user'] ?? '?' }}</td>
                <td><span class="badge {{ $s['rating'] === 'good' ? 'pass' : ($s['rating'] === '?' ? 'pending' : 'fail') }}">{{ $s['rating'] }}</span></td>
                <td>
                    <button class="btn" style="padding: 4px 12px; font-size: 12px;"
                        onclick="addFixture('{{ $s['book_id'] }}', '{{ $s['strategy'] }}_example', '{{ $s['classification'] }} footnotes', this)">
                        Add Fixture
                    </button>
                </td>
            </tr>
            @endforeach
        </tbody>
    </table>
    @elseif(count($uncoveredStrategies) > 0)
    <h2>Fill Coverage Gaps</h2>
    <p class="muted">
        No candidate books found for uncovered strategies:
        @foreach($uncoveredStrategies as $s)
            <span class="badge uncovered">{{ $s }}</span>
        @endforeach
        <br>Import a PDF with that footnote style, or drag-and-drop an ocr_response.json above.
    </p>
    @endif

    <script>
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    let pendingFiles = [];

    // ─── Drag-and-drop ───

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const uploadForm = document.getElementById('uploadForm');

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleDroppedFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => {
        handleDroppedFiles(fileInput.files);
    });

    function handleDroppedFiles(fileList) {
        const allowed = [
            'ocr_response.json', 'debug_converted.html', 'footnote_meta.json',
            'conversion_stats.json', 'main-text.md', 'input.html',
        ];
        pendingFiles = [];
        for (const f of fileList) {
            if (allowed.includes(f.name)) {
                pendingFiles.push(f);
            }
        }

        if (pendingFiles.length === 0) {
            alert('No recognised files found. Expected: ' + allowed.join(', '));
            return;
        }

        // Show the files and form
        const listEl = document.getElementById('fileList');
        listEl.innerHTML = 'Files: ' + pendingFiles.map(f =>
            `<span>${f.name}</span> (${(f.size / 1024).toFixed(1)}KB)`
        ).join(', ');

        uploadForm.classList.add('visible');
        document.getElementById('fixtureName').focus();
    }

    function cancelUpload() {
        pendingFiles = [];
        uploadForm.classList.remove('visible');
        fileInput.value = '';
        document.getElementById('fixtureName').value = '';
        document.getElementById('fixtureDesc').value = '';
        document.getElementById('uploadStatus').textContent = '';
    }

    async function submitUpload() {
        const name = document.getElementById('fixtureName').value.trim();
        const desc = document.getElementById('fixtureDesc').value.trim();
        const btn = document.getElementById('uploadBtn');
        const status = document.getElementById('uploadStatus');

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            alert('Name must be alphanumeric with underscores/hyphens only.');
            return;
        }
        if (!desc) {
            alert('Description is required.');
            return;
        }
        if (pendingFiles.length === 0) {
            alert('No files to upload.');
            return;
        }

        btn.disabled = true;
        status.innerHTML = '<span class="spinner"></span> Creating fixture...';

        const formData = new FormData();
        formData.append('name', name);
        formData.append('description', desc);
        for (const f of pendingFiles) {
            formData.append('files[]', f);
        }

        try {
            const resp = await fetch('/api/conversion-tests/upload-fixture', {
                method: 'POST',
                headers: { 'X-CSRF-TOKEN': csrfToken },
                credentials: 'include',
                body: formData,
            });

            const data = await resp.json();

            if (data.error) {
                status.textContent = 'Failed: ' + data.error;
                btn.disabled = false;
                return;
            }

            status.textContent = 'Created!';
            btn.style.background = '#22c55e';
            btn.style.color = '#221F20';
            setTimeout(() => window.location.reload(), 1000);
        } catch (err) {
            status.textContent = 'Error: ' + err.message;
            btn.disabled = false;
        }
    }

    // ─── Run tests ───

    async function runTests() {
        const btn = document.getElementById('runBtn');
        const status = document.getElementById('runStatus');
        const summaryResult = document.getElementById('summaryResult');

        btn.disabled = true;
        btn.classList.remove('fail');
        status.innerHTML = '<span class="spinner"></span> Running...';
        summaryResult.textContent = '...';
        summaryResult.className = 'value pending';

        document.querySelectorAll('.result-cell').forEach(cell => {
            cell.innerHTML = '<span class="badge pending"><span class="spinner"></span></span>';
        });
        document.querySelectorAll('.checks').forEach(cell => { cell.textContent = ''; });

        try {
            const resp = await fetch('/api/conversion-tests/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken },
                credentials: 'include',
            });

            const data = await resp.json();

            if (data.error) {
                status.textContent = 'Error: ' + data.error;
                btn.disabled = false;
                return;
            }

            if (data.failed === 0) {
                summaryResult.textContent = 'ALL PASS';
                summaryResult.className = 'value pass';
                status.textContent = `${data.passed} passed`;
            } else {
                summaryResult.textContent = `${data.failed} FAIL`;
                summaryResult.className = 'value fail';
                btn.classList.add('fail');
                status.textContent = `${data.passed} passed, ${data.failed} failed`;
            }

            for (const fixture of (data.fixtures || [])) {
                const row = document.querySelector(`tr[data-fixture="${fixture.name}"]`);
                if (!row) continue;

                const resultCell = row.querySelector('.result-cell');
                const checksCell = row.querySelector('.checks');

                resultCell.innerHTML = fixture.passed
                    ? '<span class="badge pass">PASS</span>'
                    : '<span class="badge fail">FAIL</span>';

                const parts = (fixture.checks || []).map(c => {
                    const cls = c.passed ? 'check-pass' : 'check-fail';
                    const icon = c.passed ? '\u2713' : '\u2717';
                    return `<span class="${cls}">${icon} ${c.name}: ${c.message}</span>`;
                });
                checksCell.innerHTML = parts.join('<br>');
            }
        } catch (err) {
            status.textContent = 'Request failed: ' + err.message;
        }

        btn.disabled = false;
    }

    // ─── Add fixture from suggestion ───

    async function addFixture(bookId, name, description, btn) {
        btn.disabled = true;
        btn.textContent = 'Adding...';

        try {
            const resp = await fetch('/api/conversion-tests/add-fixture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken },
                credentials: 'include',
                body: JSON.stringify({ bookId, name, description }),
            });

            const data = await resp.json();

            if (data.error) {
                btn.textContent = 'Failed';
                btn.classList.add('fail');
                alert('Failed: ' + data.error);
                return;
            }

            btn.textContent = 'Added!';
            btn.style.background = '#22c55e';
            btn.style.color = '#221F20';
            setTimeout(() => window.location.reload(), 1000);
        } catch (err) {
            btn.textContent = 'Error';
            btn.classList.add('fail');
            alert('Request failed: ' + err.message);
        }
    }
    </script>
</body>
</html>
