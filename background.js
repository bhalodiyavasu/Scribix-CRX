// ── Constant Default Models ──────────────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'];
const OPENROUTER_MODELS = ['openrouter/free', 'google/gemini-2.5-flash:free', 'meta-llama/llama-3-8b-instruct:free'];

// ── Configure Side Panel Behavior ───────────────────────────────────────────
if (typeof chrome !== 'undefined' && chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn('[Content Enhancer Background] Failed to set panel behavior:', err);
  });
}

// ── Extension Action (Toolbar Button) Click Listener (Fallback) ──────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    // Enable side panel for this tab
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel/sidepanel.html',
      enabled: true
    }).catch(() => {});

    // Open side panel
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }

    // Try sending show message, inject content.js if it fails
    const injected = await ensureContentScriptInjected(tab.id);
    if (injected) {
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_INDICATORS' }).catch(() => {});
    }
  } catch (e) {
    console.error('[Content Enhancer Background]', e);
  }
});

// ── Long-Lived Port Connection Listener (detects sidepanel close) ──────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    let associatedTabId = null;

    port.onMessage.addListener((msg) => {
      if (msg.type === 'INIT_PORT' && msg.tabId) {
        associatedTabId = msg.tabId;
      }
    });

    port.onDisconnect.addListener(() => {
      if (associatedTabId) {
        chrome.tabs.sendMessage(associatedTabId, { type: 'HIDE_INDICATORS' }).catch(() => {});
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'HIDE_INDICATORS' }).catch(() => {});
          }
        });
      }
    });
  }
});

// Helper to check if content script is injected, injects if not
async function ensureContentScriptInjected(tabId) {
  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true;
    } catch (e) {
      if (i === 0) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });
        } catch (err) {
          console.error('[Content Enhancer] Script injection failed:', err);
          return false;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  return false;
}

// ── Model Fetching Helpers ───────────────────────────────────────────────────
async function fetchModelsForProvider(provider, apiKey) {
  if (provider === 'GEMINI') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Failed to fetch Gemini models: ${res.status} - ${txt}`);
    }
    const data = await res.json();
    return (data.models || [])
      .filter(m => m.name && m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  } else {
    // OpenRouter
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Failed to fetch OpenRouter models: ${res.status} - ${txt}`);
    }
    const data = await res.json();
    return (data.data || []).map(m => m.id);
  }
}

async function getModelsHelper(provider, customDefaultKey, customBackupKey) {
  let keysToTry = [];
  if (customDefaultKey) keysToTry.push(customDefaultKey);
  if (customBackupKey) keysToTry.push(customBackupKey);

  if (keysToTry.length === 0) {
    const fallbackModels = provider === 'GEMINI' ? GEMINI_MODELS : OPENROUTER_MODELS;
    return { success: false, models: fallbackModels, error: 'No API keys provided. Please configure a key in the settings panel.' };
  }

  let lastError = null;
  for (const key of keysToTry) {
    try {
      const models = await fetchModelsForProvider(provider, key);
      if (models && models.length > 0) {
        return { success: true, models };
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  const fallbackModels = provider === 'GEMINI' ? GEMINI_MODELS : OPENROUTER_MODELS;
  return { success: false, models: fallbackModels, error: lastError };
}

// ── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_SIDE_PANEL') {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      const tabId = msg.tabId || sender?.tab?.id;
      if (tabId) {
        chrome.sidePanel.setOptions({
          tabId: tabId,
          path: 'sidepanel/sidepanel.html',
          enabled: true
        }).then(() => {
          return chrome.sidePanel.open({ tabId });
        })
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          console.error('[Content Enhancer] Failed to open side panel:', err);
          sendResponse({ success: false, error: err.message });
        });
        return true;
      }
    }
    sendResponse({ success: false, error: 'sidePanel API not supported or invalid tab ID' });
  } else if (msg.type === 'FETCH_MODELS') {
    getModelsHelper(msg.provider, msg.defaultKey, msg.backupKey)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, models: [], error: err.message }));
    return true; // Keep channel open
  } else if (msg.type === 'INJECT_AND_SHOW') {
    ensureContentScriptInjected(msg.tabId).then((injected) => {
      if (injected) {
        chrome.tabs.sendMessage(msg.tabId, { type: 'SHOW_INDICATORS' }).catch(() => {});
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Injection failed' });
      }
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
});

// ── Context Menu Setup ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "enhance-field",
    title: "Enhance with Content Enhancer",
    contexts: ["editable"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "enhance-field" && tab?.id) {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_CONTEXT_MENU_SELECT' }).catch(() => {});
  }
});
