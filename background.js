let isRunning = false;
let isManualRunning = false;
let checkLoopActive = false;
let checkedDomains = [];
let foundDomains = [];

// Allow users to open the side panel by clicking on the action toolbar icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

function updateStatus(text, runningState) {
    if (runningState !== undefined) {
        isRunning = runningState;
        chrome.storage.local.set({ isRunning });
    }
    chrome.storage.local.set({ currentStatusText: text });
    chrome.runtime.sendMessage({ action: "UPDATE_STATE", isRunning: runningState, statusText: text, foundDomains });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "STATE_START") {
        if (!isRunning) {
            startHunting();
        }
    } else if (message.action === "STATE_STOP") {
        isRunning = false;
        updateStatus("Stopped", false);
    } else if (message.action === "MANUAL_CHECK_START") {
        if (!isManualRunning) {
            isManualRunning = true;
            runManualCheckLoop(message.domains);
        }
    } else if (message.action === "MANUAL_CHECK_STOP") {
        isManualRunning = false;
    }
});

async function startHunting() {
    updateStatus("Initializing...", true);
    checkedDomains = [];
    
    const data = await chrome.storage.local.get(['apiKey', 'keywords', 'promptInstructions', 'batchSize', 'targetCount', 'selectedSuffixes']);
    if (!data.apiKey || !data.keywords) {
        updateStatus("Missing API Key or Keywords", false);
        return;
    }
    
    foundDomains = [];
    chrome.storage.local.set({ foundDomains: [] });
    
    runHuntLoop(data);
}

async function runHuntLoop(data) {
    if (!isRunning) return;
    checkLoopActive = true;

    try {
        updateStatus(`Generating domains with AI... (${foundDomains.length}/${data.targetCount || 5} found)`, true);
        const domainsToVerify = await generateDomainsFromGemini(data);
        
        if (!domainsToVerify || domainsToVerify.length === 0) {
            updateStatus("AI returned no domains. Retrying...", true);
            await sleep(2000);
            if (isRunning) runHuntLoop(data);
            return;
        }

        updateStatus(`Checking ${domainsToVerify.length} domains...`, true);
        
        let targetTabId = await getTargetTab();
        if (!targetTabId) {
            updateStatus("Opening instantdomainsearch.com...", true);
            const tab = await chrome.tabs.create({ url: "https://instantdomainsearch.com", active: false });
            targetTabId = tab.id;
            await sleep(3000); // wait for load
        } else {
            // Try to make sure it's active so scripts run faster
            chrome.tabs.update(targetTabId, { active: true });
        }

        for (let i = 0; i < domainsToVerify.length; i++) {
            if (!isRunning) break;
            
            const domain = domainsToVerify[i].trim().toLowerCase();
            if (!domain || checkedDomains.includes(domain)) continue;
            
            checkedDomains.push(domain);
            updateStatus(`working... (${i + 1} out of ${domainsToVerify.length})`, true);
            
            const result = await checkDomainInContentScript(targetTabId, domain);
            
            // Send log to UI
            chrome.runtime.sendMessage({
                action: 'logDomain',
                domain: domain,
                status: result
            });
            
            if (result === 'available') {
                foundDomains.push(domain);
                chrome.storage.local.set({ foundDomains });
                
                if (foundDomains.length >= (data.targetCount || 5)) {
                    updateStatus(`Target reached! Found ${foundDomains.length} domains.`, false);
                    return; 
                }
            } else if (result === 'premium') {
                // expensive broker domain, do not add to foundDomains, but it was logged!
            } else if (result === 'taken') {
                // taken, do nothing
            } else if (result === 'error' || result === 'timeout') {
                console.warn(`Could not check ${domain}, status: ${result}`);
            }
            
            if (isRunning) {
                // Keep delay practically instantaneous. The content script handles waiting for the DOM.
                const delay = Math.floor(Math.random() * 50) + 50;
                await sleep(delay);
            }
        }
        
        if (isRunning && foundDomains.length < (data.targetCount || 5)) {
            updateStatus("finished... next batch with a bit new variant...", true);
            await sleep(1500);
            runHuntLoop(data);
        }

    } catch (err) {
        console.error("Error in loop:", err);
        updateStatus("Error: " + err.message, false);
    } finally {
        checkLoopActive = false;
    }
}

async function runManualCheckLoop(domains) {
    const total = domains.length;
    updateStatus(`Manual check: 0/${total}`, true);

    let targetTabId = await getTargetTab();
    if (!targetTabId) {
        updateStatus("Opening instantdomainsearch.com...", true);
        const tab = await chrome.tabs.create({ url: "https://instantdomainsearch.com", active: false });
        targetTabId = tab.id;
        await sleep(3000);
    } else {
        chrome.tabs.update(targetTabId, { active: true });
    }

    for (let i = 0; i < domains.length; i++) {
        if (!isManualRunning) break;

        const domain = domains[i].trim().toLowerCase();
        if (!domain) continue;

        updateStatus(`Manual check: ${i + 1}/${total} — ${domain}.com`, true);

        const result = await checkDomainInContentScript(targetTabId, domain);

        chrome.runtime.sendMessage({
            action: 'logDomain',
            domain: domain,
            status: result
        });

        if (isManualRunning) await sleep(100);
    }

    isManualRunning = false;
    updateStatus('Manual check complete.', false);
    chrome.runtime.sendMessage({ action: 'MANUAL_CHECK_DONE' });
}

async function generateDomainsFromGemini(data) {
    const batchSize = data.batchSize || 30;
    const defaultPrompt = `You are a highly creative, unpredictable AI brand naming expert. Your job is to generate ${batchSize} HIGH-QUALITY, UNIQUE domain names based on the user's keywords.

CRITICAL RULES YOU MUST FOLLOW:
1. Base name ONLY (NO .com, NO extensions).
2. NO HYPHENS (-), NO NUMBERS. Alphabetical letters only.
3. Keep it between 8 to 12 letters maximum.
4. Extremely easy to pronounce, memorable, and relatable. 
5. BE HIGHLY VARIABLE AND CREATIVE. Do NOT just append standard words to keywords. Invent vivid, unexpected combinations (e.g., 'CloudRiver', 'NeonForge', 'SwiftLeaf', 'AuraGlow', 'ZenithPulse').
6. NEVER REPEAT OR OUTPUT ANY PREVIOUSLY GENERATED DOMAINS. Use deep variety in your vocabulary.`;

    const prompt = data.promptInstructions ? `${defaultPrompt}\n\nUSER'S CUSTOM INSTRUCTIONS:\n${data.promptInstructions}` : defaultPrompt;
    
    let suffixText = "";
    if (data.selectedSuffixes && data.selectedSuffixes.length > 0) {
        suffixText = `\n\nREQUIRED MIX-INS:\nYou must append one of these suffix words to the end of at least half of the domain names: [${data.selectedSuffixes.join(', ')}].`;
    }
    
    
    const requestBody = {
        contents: [{
            parts: [{
                text: `${prompt}${suffixText}\n\nKeywords: ${data.keywords}\n\nGenerate ${batchSize} entirely new, different domain names. Do not include these already checked domains: ${checkedDomains.length > 0 ? checkedDomains.slice(-batchSize).join(', ') : 'None yet.'}`
            }]
        }],
        generationConfig: {
            temperature: 0.9,
            topK: 40,
            responseMimeType: "application/json",
            responseSchema: {
                type: "ARRAY",
                items: {
                    type: "STRING"
                }
            }
        }
    };
    
    // Using gemini-2.5-flash which is the latest standard fast model 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${data.apiKey}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
    }
    
    const json = await response.json();
    if (json.candidates && json.candidates[0].content.parts[0].text) {
        const text = json.candidates[0].content.parts[0].text;
        try {
            const domainArray = JSON.parse(text);
            if (Array.isArray(domainArray)) {
                return domainArray.map(s => s.replace(/[^a-zA-Z]/g, '').trim().toLowerCase()).filter(Boolean);
            }
        } catch (e) {
            console.error("Failed to parse JSON response", e);
            // Fallback parsing if JSON fails
            return text.split(',').map(s => s.replace(/[^a-zA-Z]/g, '').trim().toLowerCase()).filter(Boolean);
        }
    }
    return [];
}

async function getTargetTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: "*://*.instantdomainsearch.com/*" }, (tabs) => {
            if (tabs && tabs.length > 0) {
                resolve(tabs[0].id);
            } else {
                resolve(null);
            }
        });
    });
}

async function checkDomainInContentScript(tabId, domain) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            resolve('timeout');
        }, 15000);

        chrome.tabs.sendMessage(tabId, { action: "CHECK_DOMAIN", domain }, (response) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
                // Inject the script if not active
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    files: ['content.js']
                }, () => {
                    setTimeout(() => {
                        chrome.tabs.sendMessage(tabId, { action: "CHECK_DOMAIN", domain }, (res) => {
                            if (chrome.runtime.lastError || !res) resolve('error');
                            else resolve(res.status);
                        });
                    }, 500);
                });
            } else if (response && response.status) {
                resolve(response.status);
            } else {
                resolve('unknown');
            }
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
