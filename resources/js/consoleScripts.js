async function sendBookChunksToServer(bookName) {
    const dbRequest = indexedDB.open("MarkdownDB", 13);

    dbRequest.onsuccess = async function(event) {
        const db = event.target.result;
        const transaction = db.transaction(["nodeChunks"], "readonly");
        const store = transaction.objectStore("nodeChunks");

        const bookRange = IDBKeyRange.bound(
            [bookName, 0],
            [bookName, Number.MAX_VALUE]
        );

        const request = store.getAll(bookRange);

        request.onsuccess = async function() {
            const chunks = request.result;
            console.log(`Found ${chunks.length} chunks for book: ${bookName}`);
            console.log('First chunk structure:', chunks[0]); // Log first chunk

            try {
                const response = await fetch('/api/node-chunks/bulk-create', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
                    },
                    body: JSON.stringify({
                        book: bookName,
                        chunks: chunks
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    console.log('Success:', result);
                } else {
                    const errorText = await response.text();
                    console.error('Server error:', errorText);
                    try {
                        const errorJson = JSON.parse(errorText);
                        console.error('Debug info:', errorJson.debug_info);
                    } catch(e) {
                        console.error('Raw error:', errorText);
                    }
                }
            } catch (error) {
                console.error('Error sending data:', error);
            }
        };

        request.onerror = function(error) {
            console.error("Error fetching chunks:", error);
        };
    };

    dbRequest.onerror = function(error) {
        console.error("Error opening database:", error);
    };
}

sendBookChunksToServer("Marx1867Capital");
