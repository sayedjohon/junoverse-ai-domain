document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    apiKey: document.getElementById('apiKey'),
    keywords: document.getElementById('keywords'),
    promptInstructions: document.getElementById('promptInstructions'),
    batchSize: document.getElementById('batchSize'),
    targetCount: document.getElementById('targetCount'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    resetSettingsBtn: document.getElementById('resetSettingsBtn'), // Renamed from resetDetailsBtn
    clearApiBtn: document.getElementById('clearApiBtn'),
    openSiteBtn: document.getElementById('openSiteBtn'), // Renamed from openSiteLink
    statusText: document.getElementById('statusText'),
    foundCount: document.getElementById('foundCount'),
    targetDisplay: document.getElementById('targetDisplay'),
    resultsList: document.getElementById('resultsList'),
    suffixGroup: document.getElementById('suffixGroup'),
    logFilter: document.getElementById('logFilter'),
    downloadLogBtn: document.getElementById('downloadLogBtn'),
    checkManualBtn: document.getElementById('checkManualBtn'),
    stopManualBtn: document.getElementById('stopManualBtn'),
    manualDomains: document.getElementById('manualDomains')
  };

  let isRunning = false;
  let selectedSuffixes = [];
  let sessionLogs = [];

  // Load saved data
  chrome.storage.local.get(['apiKey', 'keywords', 'promptInstructions', 'batchSize', 'targetCount', 'foundDomains', 'isRunning', 'currentStatusText', 'selectedSuffixes'], (data) => {
    if (data.apiKey) elements.apiKey.value = data.apiKey;
    if (data.keywords) elements.keywords.value = data.keywords;
    if (data.promptInstructions) elements.promptInstructions.value = data.promptInstructions;
    if (data.batchSize) elements.batchSize.value = data.batchSize;
    if (data.targetCount) {
      elements.targetCount.value = data.targetCount;
      elements.targetDisplay.textContent = data.targetCount;
    }
    
    if (data.selectedSuffixes) {
      selectedSuffixes = data.selectedSuffixes;
      Array.from(elements.suffixGroup.children).forEach(pill => {
        if (selectedSuffixes.includes(pill.dataset.value)) {
          pill.classList.add('active');
        }
      });
    }
    
    updateUIState(data.isRunning || false);
    if (data.currentStatusText) {
        elements.statusText.textContent = data.currentStatusText;
    }
    renderResults(data.foundDomains || []);
  });

  // Save inputs on change
  const saveInputs = () => {
    chrome.storage.local.set({
      apiKey: elements.apiKey.value,
      keywords: elements.keywords.value,
      promptInstructions: elements.promptInstructions.value,
      batchSize: parseInt(elements.batchSize.value, 10) || 30,
      targetCount: parseInt(elements.targetCount.value, 10) || 5,
      selectedSuffixes: selectedSuffixes
    });
    elements.targetDisplay.textContent = elements.targetCount.value;
  };

  ['apiKey', 'keywords', 'promptInstructions', 'batchSize', 'targetCount'].forEach(id => {
    elements[id].addEventListener('input', saveInputs);
  });

  if (elements.suffixGroup) {
      elements.suffixGroup.addEventListener('click', (e) => {
        if (e.target.classList.contains('pill')) {
          const val = e.target.dataset.value;
          if (selectedSuffixes.includes(val)) {
            selectedSuffixes = selectedSuffixes.filter(s => s !== val);
            e.target.classList.remove('active');
          } else {
            selectedSuffixes.push(val);
            e.target.classList.add('active');
          }
          saveInputs();
        }
      });
  }

  // Handle opening the site
  if (elements.openSiteBtn) {
    elements.openSiteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: "https://instantdomainsearch.com" });
    });
  }

  // Handle resetting details (leaves API key alone)
  if (elements.resetSettingsBtn) {
    elements.resetSettingsBtn.addEventListener('click', () => {
      if (confirm("Reset keywords, prompts, and settings? This will not clear your API key.")) {
        elements.keywords.value = '';
        elements.promptInstructions.value = '';
        elements.batchSize.value = 30;
        elements.targetCount.value = 5;
        elements.targetDisplay.textContent = 5;
        selectedSuffixes = [];
        if (elements.suffixGroup) {
          Array.from(elements.suffixGroup.children).forEach(p => p.classList.remove('active'));
        }
        saveInputs();
      }
    });
  }

  // Handle clearing API key
  if (elements.clearApiBtn) {
    elements.clearApiBtn.addEventListener('click', () => {
       if (confirm("Clear Gemini API Key?")) {
         elements.apiKey.value = '';
         saveInputs();
       }
    });
  }
  
  // Log Filtering
  if (elements.logFilter) {
    elements.logFilter.addEventListener('change', () => {
      renderLogs();
    });
  }
  
  // Download Report
  if (elements.downloadLogBtn) {
    elements.downloadLogBtn.addEventListener('click', () => {
      const filter = elements.logFilter.value;
      const filtered = filter === 'all' ? sessionLogs : sessionLogs.filter(l => l.status === filter || (filter === 'error' && (l.status === 'timeout' || l.status === 'error')));
      
      if (filtered.length === 0) return alert('No domains match this filter.');
      
      let content = "JunoverseAI Domain Report\n";
      content += "Generated: " + new Date().toLocaleString() + "\n\n";
      
      filtered.forEach(log => {
        content += `${log.domain}.com - ${log.status.toUpperCase()}\n`;
      });
      
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().slice(0, 16).replace(/T|:/g, '-');
      a.download = `JunoverseAI-domains-${dateStr}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  elements.startBtn.addEventListener('click', () => {
    if (!elements.apiKey.value || !elements.keywords.value) {
      alert("Please provide API Key and Keywords");
      return;
    }
    
    // Check if we need to request permissions for the active tab (though host_permissions should cover it)
    chrome.permissions.request({
      origins: ['*://*.instantdomainsearch.com/*']
    }, (granted) => {
      if (granted) {
        startHunting();
      } else {
        alert("Permission to access instantdomainsearch.com is required.");
      }
    });
  });

  function startHunting() {
    chrome.storage.local.set({ isRunning: true, foundDomains: [], currentStatusText: "Initializing..." }, () => {
      updateUIState(true);
      elements.statusText.textContent = "Initializing...";
      renderResults([]);
      chrome.runtime.sendMessage({ action: "STATE_START" });
    });
  }

  elements.stopBtn.addEventListener('click', () => {
    chrome.storage.local.set({ isRunning: false, currentStatusText: "Stopped" }, () => {
      updateUIState(false);
      elements.statusText.textContent = "Stopped";
      chrome.runtime.sendMessage({ action: "STATE_STOP" });
    });
  });

  // ── Manual Domain Check ──
  if (elements.checkManualBtn) {
    elements.checkManualBtn.addEventListener('click', () => {
      const raw = elements.manualDomains.value || '';
      const domains = raw
        .split('\n')
        .map(d => d.trim().toLowerCase().replace(/\.com$/i, '').replace(/[^a-z0-9-]/g, ''))
        .filter(Boolean);

      if (domains.length === 0) {
        alert('Please enter at least one domain name (one per line).');
        return;
      }

      // Show stop button, disable check button
      elements.checkManualBtn.style.display = 'none';
      elements.stopManualBtn.style.display = 'block';
      elements.manualDomains.disabled = true;

      chrome.runtime.sendMessage({ action: 'MANUAL_CHECK_START', domains });
    });
  }

  if (elements.stopManualBtn) {
    elements.stopManualBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'MANUAL_CHECK_STOP' });
      resetManualUI();
    });
  }

  function resetManualUI() {
    elements.checkManualBtn.style.display = 'block';
    elements.stopManualBtn.style.display = 'none';
    elements.manualDomains.disabled = false;
  }

  // Listen  // Listen for background updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UPDATE_STATE') {
      if (message.isRunning !== undefined) {
        // The 'isRunning' variable is not defined in this scope, assuming it's meant to be passed to updateUIState
        // and statusText/className updates are handled by updateUIState or need to be explicitly defined here.
        // For now, preserving the original logic for statusText and calling updateUIState.
        updateUIState(message.isRunning);
        if (message.statusText) {
          elements.statusText.textContent = message.statusText;
          chrome.storage.local.set({ currentStatusText: message.statusText });
        }
      }
      
      if (message.foundDomains) {
        renderResults(message.foundDomains);
      }
    } else if (message.action === 'MANUAL_CHECK_DONE') {
      resetManualUI();
      elements.statusText.textContent = 'Manual check complete.';
    } else if (message.action === 'logDomain') {
      // Save to memory so it can be filtered or downloaded
      sessionLogs.push({ domain: message.domain, status: message.status });
      const filter = elements.logFilter.value;
      if (filter === 'all' || filter === message.status || (filter === 'error' && (message.status === 'timeout' || message.status === 'error'))) {
          const logEntry = document.createElement('div');
          logEntry.className = 'log-item';
          
          const domainSpan = document.createElement('span');
          domainSpan.textContent = `${message.domain}.com`;
          
          const statusSpan = document.createElement('span');
          statusSpan.textContent = message.status.toUpperCase();
          statusSpan.className = `log-${message.status}`;
          
          logEntry.appendChild(domainSpan);
          logEntry.appendChild(statusSpan);
          
          const checkLogList = document.getElementById('checkLogList');
          if (checkLogList) {
            checkLogList.appendChild(logEntry);
            // Keep scroll at bottom
            checkLogList.scrollTop = checkLogList.scrollHeight;
          }
      }
    }
  });

  function renderLogs() {
    const checkLogList = document.getElementById('checkLogList');
    if (!checkLogList) return;
    
    checkLogList.innerHTML = '';
    const filter = elements.logFilter.value;
    
    const filtered = filter === 'all' ? sessionLogs : sessionLogs.filter(l => l.status === filter || (filter === 'error' && (l.status === 'timeout' || l.status === 'error')));
    
    filtered.forEach(log => {
      const logEntry = document.createElement('div');
      logEntry.className = 'log-item';
      
      const domainSpan = document.createElement('span');
      domainSpan.textContent = `${log.domain}.com`;
      
      const statusSpan = document.createElement('span');
      statusSpan.textContent = log.status.toUpperCase();
      statusSpan.className = `log-${log.status}`;
      
      logEntry.appendChild(domainSpan);
      logEntry.appendChild(statusSpan);
      checkLogList.appendChild(logEntry);
    });
    checkLogList.scrollTop = checkLogList.scrollHeight;
  }

  function updateUIState(isRunning) {
    elements.startBtn.style.display = isRunning ? 'none' : 'block';
    elements.stopBtn.style.display = isRunning ? 'block' : 'none';
    elements.statusText.classList.toggle('running', isRunning);
    if (!isRunning && elements.statusText.textContent === "Initializing...") {
       elements.statusText.textContent = "Idle";
    }
    
    // Disable inputs while running
    ['apiKey', 'keywords', 'promptInstructions', 'batchSize', 'targetCount'].forEach(id => {
      elements[id].disabled = isRunning;
    });
    
    if (elements.suffixGroup) {
        elements.suffixGroup.style.pointerEvents = isRunning ? 'none' : 'auto';
        elements.suffixGroup.style.opacity = isRunning ? '0.6' : '1';
    }
    if (elements.resetDetailsBtn) elements.resetDetailsBtn.disabled = isRunning;
    if (elements.clearApiBtn) elements.clearApiBtn.disabled = isRunning;
  }

  function renderResults(domains) {
    elements.foundCount.textContent = domains.length;
    elements.resultsList.innerHTML = '';
    domains.forEach(domain => {
      const div = document.createElement('div');
      div.className = 'result-item';
      div.textContent = `${domain}.com`;
      elements.resultsList.appendChild(div);
    });
  }
});
