// Content script for instantdomainsearch.com
// Domain State Reference: see dom_reference.md for full HTML structure documentation.
//
// STATES (based on `status` attribute on `a` inside `div.flex.w-32` in the matched `div.group` row):
//   status="available" → AVAILABLE  (green dot, "Continue" button)
//   status="taken"     → TAKEN      (red dot, "Lookup" button)
//   status="sale"      → PREMIUM    (blue dot, price shown e.g. "$9,695")
//   status="offer"     → PREMIUM    (blue dot, "Make offer" button)
//   (none after 2s)    → TIMEOUT

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "CHECK_DOMAIN") {
        checkDomain(message.domain).then(status => {
            sendResponse({ status });
        }).catch(err => {
            console.error("Error checking domain:", err);
            sendResponse({ status: "error" });
        });
        return true; // Keep message channel open for async response
    }
});

async function checkDomain(domain) {
    const searchBox = document.querySelector('#SearchBox_search');
    if (!searchBox) {
        throw new Error("Search box not found");
    }

    // Clear and type the new domain
    searchBox.value = '';
    searchBox.dispatchEvent(new Event('input', { bubbles: true }));
    searchBox.dispatchEvent(new Event('change', { bubbles: true }));
    
    await sleep(50);
    
    searchBox.value = domain;
    searchBox.focus();
    searchBox.dispatchEvent(new Event('input', { bubbles: true }));
    searchBox.dispatchEvent(new Event('change', { bubbles: true }));
    searchBox.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    
    return await waitForResult(domain);
}

function waitForResult(domain) {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 80; // 4 seconds (50ms * 80)
        const targetText = `${domain}.com`.toLowerCase();

        // The site uses an optimistic UI — it may flash status="available" 
        // briefly while the real backend check runs, then flip to "taken".
        // So we CONFIRM "available" by requiring it to be stable for 10
        // consecutive ticks (~500ms). Taken/premium are trusted immediately.
        let availableConfirmCount = 0;
        const AVAILABLE_CONFIRM_NEEDED = 10; // 500ms of stable "available"

        const checkInterval = setInterval(() => {
            const rows = Array.from(document.querySelectorAll('div.group'));

            let targetRow = null;
            for (const row of rows) {
                const span = row.querySelector('span.truncate');
                if (span && span.innerText && span.innerText.trim().toLowerCase() === targetText) {
                    targetRow = row;
                    break;
                }
            }

            if (targetRow) {
                const actionLink = targetRow.querySelector('a[status]');

                if (actionLink) {
                    const statusAttr = actionLink.getAttribute('status');

                    // "taken" → immediate. The Lookup button confirms it.
                    if (statusAttr === 'taken') {
                        clearInterval(checkInterval);
                        resolve('taken');
                        return;
                    }

                    // "sale" / "offer" → premium, immediate.
                    if (statusAttr === 'sale' || statusAttr === 'offer') {
                        clearInterval(checkInterval);
                        resolve('premium');
                        return;
                    }

                    // "available" → DON'T trust immediately.
                    // The site flashes "available" before the real check returns.
                    // Confirm it's still available after 500ms of stability.
                    if (statusAttr === 'available') {
                        availableConfirmCount++;
                        if (availableConfirmCount >= AVAILABLE_CONFIRM_NEEDED) {
                            clearInterval(checkInterval);
                            resolve('available');
                        }
                        // else: keep polling — may flip to "taken"
                        return;
                    }

                    // Any other status resets the available counter
                    availableConfirmCount = 0;

                } else {
                    // Row appeared but no a[status] yet — reset available counter
                    availableConfirmCount = 0;
                }
            } else {
                // Row not found yet — reset counter
                availableConfirmCount = 0;
            }

            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                const pageText = document.body.innerText.toLowerCase();
                resolve(pageText.includes(targetText) ? 'timeout' : 'timeout');
            }
        }, 50);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
