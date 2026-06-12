// ── Constant Default Models ──────────────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'];
const OPENROUTER_MODELS = ['openrouter/free', 'google/gemini-2.5-flash:free', 'meta-llama/llama-3-8b-instruct:free'];

// ── Configure Side Panel Behavior ───────────────────────────────────────────
if (typeof chrome !== 'undefined' && chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn('[Scribix Background] Failed to set panel behavior:', err);
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
    console.error('[Scribix Background]', e);
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
          console.error('[Scribix] Script injection failed:', err);
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
          console.error('[Scribix] Failed to open side panel:', err);
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
  } else if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender?.tab?.id });
    return false;
  } else if (msg.type === 'GENERATE_AI') {
    // Direct AI generation request from content script (Enter key in input)
    (async () => {
      try {
        const settings = await chrome.storage.local.get([
          'aiProvider', 'geminiDefaultKey', 'geminiSelectedModel',
          'openrouterDefaultKey', 'openrouterSelectedModel'
        ]);

        const provider = settings.aiProvider || 'GEMINI';
        const apiKey = provider === 'GEMINI' ? settings.geminiDefaultKey : settings.openrouterDefaultKey;
        const modelName = provider === 'GEMINI'
          ? (settings.geminiSelectedModel || 'gemini-1.5-flash')
          : (settings.openrouterSelectedModel || 'openrouter/free');

        if (!apiKey) {
          sendResponse({ success: false, error: 'No API key configured' });
          return;
        }

        const systemPrompt = `You are an input field filler. Return ONLY the final raw text to fill the field.
Strict rules:
1. No chat, preamble, notes, explanations, markdown formatting, or quotes.
2. Interpret the user's core intent even if the input is short, fragmented, or has informal/reversed word order.
3. If the intent is to generate mock/random/placeholder data (e.g. email, phone, name, address, number, specific domain mail), generate a highly realistic, professional, and format/country-appropriate random value. Do NOT output generic dummy placeholders unless specifically requested.
4. If the intent is to process, translate, rewrite, or enhance existing text, execute that specific operation directly in a highly polished, professional, and natural manner.

Context:
Label: "${msg.fieldLabel || 'Text input'}"
Placeholder: "${msg.fieldPlaceholder || ''}"
Existing: "${msg.existingValue || ''}"`;

        const randomSeed = Math.random().toString(36).substring(7);
        let responseText = '';

        if (provider === 'GEMINI') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: `${msg.prompt}\n\n[Seed: ${randomSeed}]` }] }],
              generationConfig: { temperature: 1.0 }
            })
          });
          if (!res.ok) throw new Error(`API error: ${res.status}`);
          const data = await res.json();
          responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://github.com/vasubhalodiya',
              'X-Title': 'Scribix'
            },
            body: JSON.stringify({
              model: modelName,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${msg.prompt}\n\n[Seed: ${randomSeed}]` }
              ],
              temperature: 1.0
            })
          });
          if (!res.ok) throw new Error(`API error: ${res.status}`);
          const data = await res.json();
          responseText = data.choices?.[0]?.message?.content || '';
        }

        sendResponse({ success: true, text: responseText });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async
  }
});

// ── Context Menu Setup ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "enhance-field",
    title: "Enhance with Scribix",
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
