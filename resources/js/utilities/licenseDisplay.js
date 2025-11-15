/**
 * License Display Module
 * Shows the content license for the current book
 */

import { openDatabase } from '../indexedDB/index.js';
import { book } from '../app.js';

const LICENSE_INFO = {
  'CC-BY-SA-4.0-NO-AI': {
    short: 'CC BY-SA 4.0 (No AI)',
    long: 'Creative Commons Attribution-ShareAlike 4.0 (No AI Training)',
    url: '/LICENSE-CONTENT.md'
  },
  'CC-BY-4.0': {
    short: 'CC BY 4.0',
    long: 'Creative Commons Attribution 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/'
  },
  'CC-BY-NC-SA-4.0': {
    short: 'CC BY-NC-SA 4.0',
    long: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
  },
  'CC0': {
    short: 'CC0',
    long: 'Public Domain (CC0 1.0)',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/'
  },
  'All-Rights-Reserved': {
    short: 'All Rights Reserved',
    long: 'All Rights Reserved - Private Content',
    url: null
  },
  'custom': {
    short: 'Custom License',
    long: 'Custom License Terms',
    url: null
  }
};

/**
 * Display the license notice for the current book
 */
export async function displayLicenseNotice() {
  try {
    const db = await openDatabase();
    const tx = db.transaction('library', 'readonly');
    const store = tx.objectStore('library');
    const request = store.get(book);

    request.onsuccess = () => {
      const record = request.result;
      if (!record) {
        console.log('No library record found for license display');
        return;
      }

      const license = record.license || 'CC-BY-SA-4.0-NO-AI';
      const licenseInfo = LICENSE_INFO[license];

      if (!licenseInfo) {
        console.warn(`Unknown license type: ${license}`);
        return;
      }

      const licenseNotice = document.getElementById('license-notice');
      const licenseText = document.getElementById('license-text');

      if (!licenseNotice || !licenseText) {
        console.warn('License notice elements not found in DOM');
        return;
      }

      // Build license text with link if URL exists
      if (licenseInfo.url) {
        licenseText.innerHTML = `📄 <a href="${licenseInfo.url}" target="_blank" style="color: #888; text-decoration: underline;" title="${licenseInfo.long}">${licenseInfo.short}</a>`;
      } else if (license === 'custom' && record.custom_license_text) {
        // For custom licenses, show a tooltip with the full text
        licenseText.innerHTML = `📄 <span style="cursor: help; border-bottom: 1px dotted #888;" title="${escapeHtml(record.custom_license_text)}">${licenseInfo.short}</span>`;
      } else {
        licenseText.innerHTML = `📄 ${licenseInfo.short}`;
      }

      // Fade in the license notice
      setTimeout(() => {
        licenseNotice.style.opacity = '1';
      }, 1000);
    };

    request.onerror = () => {
      console.error('Error fetching license from IndexedDB:', request.error);
    };

  } catch (error) {
    console.error('Error displaying license notice:', error);
  }
}

/**
 * Escape HTML to prevent XSS in tooltips
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Initialize license display
 */
export function initLicenseDisplay() {
  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', displayLicenseNotice);
  } else {
    displayLicenseNotice();
  }
}
