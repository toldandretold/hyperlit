// Add this at the top of your script
export function debugLog(message, data) {
    // Get existing logs
    const logs = JSON.parse(localStorage.getItem('debugLogs') || '[]');
    
    // Add new log with timestamp
    logs.push({
        time: new Date().toISOString(),
        message: message,
        data: data
    });
    
    // Keep only the last 20 logs
    while (logs.length > 20) logs.shift();
    
    // Save back to localStorage
    localStorage.setItem('debugLogs', JSON.stringify(logs));
    
    // Also log to console if available
    console.log(message, data);
}

// Add this function to create a debug panel
export function createDebugPanel() {
    // Create debug panel if it doesn't exist
    if (!document.getElementById('debug-panel')) {
        const panel = document.createElement('div');
        panel.id = 'debug-panel';
        panel.style.cssText = 'position:fixed; bottom:0; right:0; width:400px; height:200px; background:black; color:lime; overflow:auto; padding:10px; font-family:monospace; z-index:9999; opacity:0.9;';
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'position:absolute; top:5px; right:5px;';
        closeBtn.onclick = () => panel.style.display = 'none';
        
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear Logs';
        clearBtn.style.cssText = 'position:absolute; top:5px; right:60px;';
        clearBtn.onclick = () => {
            localStorage.removeItem('debugLogs');
            updateDebugPanel();
        };
        
        panel.appendChild(closeBtn);
        panel.appendChild(clearBtn);
        document.body.appendChild(panel);
    }
    
    // Update the panel with logs
    updateDebugPanel();
}

export function updateDebugPanel() {
    const panel = document.getElementById('debug-panel');
    if (!panel) return;
    
    const logs = JSON.parse(localStorage.getItem('debugLogs') || '[]');
    
    // Clear existing content except buttons
    Array.from(panel.childNodes).forEach(node => {
        if (node.tagName !== 'BUTTON') panel.removeChild(node);
    });
    
    // Add logs
    const logContent = document.createElement('div');
    logContent.style.marginTop = '30px';
    
    logs.forEach(log => {
        const logEntry = document.createElement('div');
        logEntry.style.borderBottom = '1px solid #333';
        logEntry.style.paddingBottom = '5px';
        logEntry.style.marginBottom = '5px';
        
        const time = new Date(log.time).toLocaleTimeString();
        logEntry.innerHTML = `<strong>${time}</strong>: ${log.message}`;
        
        if (log.data) {
            const dataStr = typeof log.data === 'object' 
                ? JSON.stringify(log.data, null, 2) 
                : log.data.toString();
            
            const dataDiv = document.createElement('pre');
            dataDiv.textContent = dataStr;
            dataDiv.style.marginLeft = '10px';
            dataDiv.style.color = '#aaffaa';
            logEntry.appendChild(dataDiv);
        }
        
        logContent.appendChild(logEntry);
    });
    
    panel.appendChild(logContent);
    
    // Scroll to bottom
    panel.scrollTop = panel.scrollHeight;
}