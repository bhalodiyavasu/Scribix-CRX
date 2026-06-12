document.addEventListener('DOMContentLoaded', () => {
  // Connect to background to monitor connection lifecycle (hides dots when closed)
  let port = null;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
    port = chrome.runtime.connect({ name: 'sidepanel' });
  }

  let activeTabId = null;

  // Request showing indicators on panel open & clear context
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        activeTabId = tab.id;
        if (port) {
          port.postMessage({
            type: 'INIT_PORT',
            tabId: tab.id,
            windowId: tab.windowId
          });
        }
        // Clear active input context for this tab on load so we start in a clean empty state
        chrome.storage.local.remove(`activeInputContext_${activeTabId}`, () => {
          chrome.runtime.sendMessage({ type: 'INJECT_AND_SHOW', tabId: activeTabId }, (res) => {
            if (chrome.runtime.lastError || !res?.success) {
              console.warn('[Content Enhancer] Failed to inject/show via background:', chrome.runtime.lastError);
            }
          });
        });
      }
    });
  }

  // ── Elements ───────────────────────────────────────────────────────────────
  const chatPanel = document.getElementById('chat-panel');
  const settingsPanel = document.getElementById('settings-panel');
  const goToSettingsBtn = document.getElementById('go-to-settings');
  const backToChatBtn = document.getElementById('back-to-chat');

  // Chat Elements
  const targetFieldName = document.getElementById('target-field-name');
  const chatMessages = document.getElementById('chat-messages');
  const userPromptInput = document.getElementById('user-prompt');
  const sendPromptBtn = document.getElementById('send-prompt');
  const originalTextPreview = document.getElementById('original-text-preview');
  const originalTextContent = document.getElementById('original-text-content');
  const clearPreviewBtn = document.getElementById('clear-preview-btn');
  const clearChatBtn = document.getElementById('clear-chat-btn');
  const composerModelTrigger = document.getElementById('composer-model-trigger');
  const composerActiveModel = document.getElementById('composer-active-model');

  // Settings Elements
  const providerTrigger = document.getElementById('provider-trigger');
  const providerSelectedLabel = document.getElementById('provider-selected-label');
  const providerMenu = document.getElementById('provider-menu');
  const defaultKeyInput = document.getElementById('crx-default-key');
  const btnToggleDefaultKey = document.getElementById('btn-toggle-default-key');
  const modelTrigger = document.getElementById('model-trigger');
  const modelSelectedLabel = document.getElementById('model-selected-label');
  const modelMenu = document.getElementById('model-menu');
  const modelSearchInput = document.getElementById('model-search-input');
  const modelListContainer = document.getElementById('model-list-container');
  const toast = document.getElementById('status-toast');
  const toastText = document.getElementById('toast-text');

  // ── State variables ────────────────────────────────────────────────────────
  let activeContext = null;
  let currentSettings = {};
  let lastSavedKey = '';
  let showApiKey = false;
  let isInputGenerating = false;
  let generatingPrompt = '';

  // ── Navigation ─────────────────────────────────────────────────────────────
  goToSettingsBtn.addEventListener('click', () => {
    chatPanel.classList.remove('active');
    settingsPanel.classList.add('active');
  });

  backToChatBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('active');
    chatPanel.classList.add('active');
  });

  composerModelTrigger.addEventListener('click', () => {
    chatPanel.classList.remove('active');
    settingsPanel.classList.add('active');
    setTimeout(() => {
      modelTrigger.click();
    }, 150);
  });

  // ── Settings Loading/Saving ────────────────────────────────────────────────
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'aiProvider',
      'geminiDefaultKey',
      'geminiSelectedModel',
      'openrouterDefaultKey',
      'openrouterSelectedModel'
    ], (res) => {
      currentSettings = res;

      // Set initial provider
      const provider = res.aiProvider || 'GEMINI';
      updateProviderUI(provider);
      loadKeysAndFetchModels(provider);
    });
  } else {
    // Static preview defaults
    currentSettings = {
      aiProvider: 'GEMINI',
      geminiSelectedModel: 'gemini-1.5-flash',
      geminiDefaultKey: 'AIzaSyFakeKeyPlaceholder'
    };
    updateProviderUI('GEMINI');
    setTimeout(() => {
      loadKeysAndFetchModels('GEMINI');
    }, 100);
  }

  function updateProviderUI(provider) {
    const label = provider === 'GEMINI' ? 'Google Gemini' : 'OpenRouter';
    providerSelectedLabel.textContent = label;

    // Update active class & check marks in provider dropdown menu
    const items = providerMenu.querySelectorAll('.ai-dropdown-item');
    items.forEach(item => {
      const val = item.getAttribute('data-value');
      const checkIcon = item.querySelector('.check-icon');
      if (val === provider) {
        item.classList.add('selected');
        if (checkIcon) checkIcon.style.display = 'block';
      } else {
        item.classList.remove('selected');
        if (checkIcon) checkIcon.style.display = 'none';
      }
    });

    // Update API Key Description & Placeholder
    const desc = document.getElementById('api-key-desc');
    if (provider === 'GEMINI') {
      desc.textContent = 'Your Google AI Studio API key';
      defaultKeyInput.placeholder = 'Enter your API key';
    } else {
      desc.textContent = 'Your OpenRouter API key';
      defaultKeyInput.placeholder = 'Enter your API key';
    }
  }

  function loadKeysAndFetchModels(provider) {
    const defaultKey = provider === 'GEMINI'
      ? (currentSettings.geminiDefaultKey || '')
      : (currentSettings.openrouterDefaultKey || '');

    defaultKeyInput.value = defaultKey;
    lastSavedKey = defaultKey;

    fetchModels(provider, defaultKey);
  }

  function fetchModels(provider, defaultKey) {
    modelSelectedLabel.innerHTML = `<span class="loading-text"><span class="icon-mask icon-spinner icon-size-xs spin" style="margin-right: 4px;"></span>Loading...</span>`;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'FETCH_MODELS',
        provider,
        defaultKey
      }, (res) => {
        const modelsList = res?.models || [];

        const savedModel = provider === 'GEMINI'
          ? currentSettings.geminiSelectedModel
          : currentSettings.openrouterSelectedModel;

        let activeModel = '';
        if (savedModel && modelsList.includes(savedModel)) {
          activeModel = savedModel;
        } else if (modelsList.length > 0) {
          activeModel = modelsList[0];
          saveSelectedModel(provider, activeModel);
        }

        modelSelectedLabel.textContent = activeModel || 'No models available';
        composerActiveModel.textContent = activeModel || 'No model';

        renderModelList(modelsList, activeModel);
      });
    } else {
      // Mock models for static preview
      setTimeout(() => {
        const fakeModels = provider === 'GEMINI'
          ? ['gemini-2.5-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro']
          : ['openrouter/free', 'google/gemini-2.5-flash:free', 'meta-llama/llama-3-8b-instruct:free'];

        const activeModel = fakeModels[0];
        modelSelectedLabel.textContent = activeModel;
        composerActiveModel.textContent = activeModel;
        renderModelList(fakeModels, activeModel);
      }, 600);
    }
  }

  function renderModelList(modelsList, selectedModel) {
    modelListContainer.innerHTML = '';

    if (modelsList.length === 0) {
      modelListContainer.innerHTML = '<div class="model-empty">No models available</div>';
      return;
    }

    modelsList.forEach(m => {
      const item = document.createElement('div');
      item.className = 'ai-dropdown-item';
      if (m === selectedModel) {
        item.classList.add('selected');
      }
      item.setAttribute('data-value', m);

      const span = document.createElement('span');
      span.className = 'model-item-label';
      span.textContent = m;
      item.appendChild(span);

      // Check Icon Span
      const checkIcon = document.createElement('span');
      checkIcon.className = 'check-icon icon-mask icon-check icon-size-sm';
      if (m !== selectedModel) {
        checkIcon.style.display = 'none';
      }
      item.appendChild(checkIcon);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectModel(m);
      });

      modelListContainer.appendChild(item);
    });
  }

  function selectModel(modelName) {
    const provider = currentSettings.aiProvider || 'GEMINI';
    saveSelectedModel(provider, modelName);

    modelSelectedLabel.textContent = modelName;
    composerActiveModel.textContent = modelName;

    // Update selected class in DOM
    const items = modelListContainer.querySelectorAll('.ai-dropdown-item');
    items.forEach(item => {
      const val = item.getAttribute('data-value');
      const checkIcon = item.querySelector('.check-icon');
      if (val === modelName) {
        item.classList.add('selected');
        if (checkIcon) checkIcon.style.display = 'block';
      } else {
        item.classList.remove('selected');
        if (checkIcon) checkIcon.style.display = 'none';
      }
    });

    modelMenu.classList.remove('visible');
    const modelChevron = modelTrigger.querySelector('.chevron-icon');
    if (modelChevron) modelChevron.classList.remove('rotated');

    showToast('Settings saved');
  }

  function saveSelectedModel(provider, model) {
    if (provider === 'GEMINI') {
      currentSettings.geminiSelectedModel = model;
      chrome.storage.local.set({ geminiSelectedModel: model });
    } else {
      currentSettings.openrouterSelectedModel = model;
      chrome.storage.local.set({ openrouterSelectedModel: model });
    }
  }

  // ── Custom Dropdowns Event Binding ─────────────────────────────────────────
  providerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    modelMenu.classList.remove('visible');
    const modelChevron = modelTrigger.querySelector('.chevron-icon');
    if (modelChevron) modelChevron.classList.remove('rotated');

    providerMenu.classList.toggle('visible');
    const providerChevron = providerTrigger.querySelector('.chevron-icon');
    if (providerChevron) providerChevron.classList.toggle('rotated');
  });

  const providerItems = providerMenu.querySelectorAll('.ai-dropdown-item');
  providerItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const newProvider = item.getAttribute('data-value');
      providerMenu.classList.remove('visible');
      const providerChevron = providerTrigger.querySelector('.chevron-icon');
      if (providerChevron) providerChevron.classList.remove('rotated');

      chrome.storage.local.set({ aiProvider: newProvider }, () => {
        currentSettings.aiProvider = newProvider;
        updateProviderUI(newProvider);
        loadKeysAndFetchModels(newProvider);
        showToast('Settings saved');
      });
    });
  });

  modelTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    providerMenu.classList.remove('visible');
    const providerChevron = providerTrigger.querySelector('.chevron-icon');
    if (providerChevron) providerChevron.classList.remove('rotated');

    modelMenu.classList.toggle('visible');
    const modelChevron = modelTrigger.querySelector('.chevron-icon');
    if (modelChevron) modelChevron.classList.toggle('rotated');

    if (modelMenu.classList.contains('visible')) {
      modelSearchInput.value = '';
      modelSearchInput.focus();
      // Reset filter
      const items = modelListContainer.querySelectorAll('.ai-dropdown-item');
      items.forEach(item => item.style.display = 'flex');
      const emptyMsg = modelListContainer.querySelector('.model-empty');
      if (emptyMsg && emptyMsg.textContent === 'No models found') emptyMsg.remove();
    }
  });

  modelSearchInput.addEventListener('input', () => {
    const query = modelSearchInput.value.trim().toLowerCase();
    const items = modelListContainer.querySelectorAll('.ai-dropdown-item');
    let visibleCount = 0;

    items.forEach(item => {
      const val = item.getAttribute('data-value');
      if (!val) return;
      if (val.toLowerCase().includes(query)) {
        item.style.display = 'flex';
        visibleCount++;
      } else {
        item.style.display = 'none';
      }
    });

    let emptyMsg = modelListContainer.querySelector('.model-empty');
    if (visibleCount === 0) {
      if (!emptyMsg) {
        emptyMsg = document.createElement('div');
        emptyMsg.className = 'model-empty';
        emptyMsg.textContent = 'No models found';
        modelListContainer.appendChild(emptyMsg);
      } else {
        emptyMsg.textContent = 'No models found';
      }
    } else {
      if (emptyMsg) emptyMsg.remove();
    }
  });

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    providerMenu.classList.remove('visible');
    const providerChevron = providerTrigger.querySelector('.chevron-icon');
    if (providerChevron) providerChevron.classList.remove('rotated');

    modelMenu.classList.remove('visible');
    const modelChevron = modelTrigger.querySelector('.chevron-icon');
    if (modelChevron) modelChevron.classList.remove('rotated');
  });

  // Stop propagation when clicking inside active menus
  providerMenu.addEventListener('click', (e) => e.stopPropagation());
  modelMenu.addEventListener('click', (e) => e.stopPropagation());

  // Eye toggle password button
  btnToggleDefaultKey.addEventListener('click', () => {
    showApiKey = !showApiKey;
    defaultKeyInput.type = showApiKey ? 'text' : 'password';

    // Toggle Eye/EyeOff SVGs
    if (showApiKey) {
      btnToggleDefaultKey.innerHTML = `<span class="icon-mask icon-eye-off icon-size-sm"></span>`;
    } else {
      btnToggleDefaultKey.innerHTML = `<span class="icon-mask icon-eye icon-size-sm"></span>`;
    }
  });

  // Key blur save
  defaultKeyInput.addEventListener('blur', () => saveKeyIfChanged());
  defaultKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      defaultKeyInput.blur();
    }
  });

  function saveKeyIfChanged() {
    const val = defaultKeyInput.value.trim();
    if (val === lastSavedKey) return;

    const provider = currentSettings.aiProvider || 'GEMINI';

    if (provider === 'GEMINI') {
      currentSettings.geminiDefaultKey = val;
      chrome.storage.local.set({ geminiDefaultKey: val }, () => {
        lastSavedKey = val;
        fetchModels(provider, val);
        showToast('Settings saved');
      });
    } else {
      currentSettings.openrouterDefaultKey = val;
      chrome.storage.local.set({ openrouterDefaultKey: val }, () => {
        lastSavedKey = val;
        fetchModels(provider, val);
        showToast('Settings saved');
      });
    }
  }

  function showToast(message, isSuccess = true) {
    toastText.textContent = message;

    toast.style.borderColor = isSuccess ? '#4174DA' : '#f48771';
    toast.style.backgroundColor = '#252526';
    toast.style.color = isSuccess ? '#ffffff' : '#f48771';

    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  // ── Context Management ──────────────────────────────────────────────────────
  const loadActiveContext = () => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && activeTabId) {
      chrome.storage.local.get([`activeInputContext_${activeTabId}`], (res) => {
        const context = res[`activeInputContext_${activeTabId}`];
        if (context) {
          updateTargetContext(context);
        } else {
          updateTargetContext(null);
        }
      });
    } else {
      updateTargetContext(null);
    }
  };

  const formatIdentifier = (str) => {
    if (!str) return '';
    str = str.trim().replace(/^_+|_+$/g, '');
    let parts = str.split(/(?=[A-Z])|[_-\s]+/);
    parts = parts.filter(p => p.trim().length > 0)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
    return parts.join(' ');
  };

  const updateTargetContext = (context) => {
    if (!context) {
      activeContext = null;
      document.getElementById('target-context-bar').style.display = 'none';
      originalTextPreview.classList.add('hidden');
      userPromptInput.disabled = true;
      userPromptInput.placeholder = 'Click robot icon or select an input field to start...';
      sendPromptBtn.disabled = true;
      return;
    }

    activeContext = context;

    // Don't re-enable inputs if currently generating
    if (!isInputGenerating) {
      userPromptInput.disabled = false;
      userPromptInput.placeholder = 'Ask anything...';
    }

    // Priority: Label -> Placeholder -> Formatted Name/ID
    let title = context.label;
    if (!title || !title.trim()) {
      title = context.placeholder;
    }
    if (!title || !title.trim()) {
      const raw = context.name || context.idAttr;
      if (raw && !raw.startsWith('enhancer_')) {
        title = formatIdentifier(raw);
      }
    }

    if (title && title.trim()) {
      targetFieldName.textContent = title.trim();
      document.getElementById('target-context-bar').style.display = 'flex';
    } else {
      document.getElementById('target-context-bar').style.display = 'none';
    }

    if (context.currentValue && context.currentValue.trim()) {
      originalTextContent.textContent = context.currentValue;
      originalTextPreview.classList.remove('hidden');
    } else {
      originalTextPreview.classList.add('hidden');
    }

    // Focus prompt input when context becomes active (not during generation)
    if (!isInputGenerating) {
      setTimeout(() => {
        userPromptInput.focus();
      }, 150);
    }
  };

  // Listen for context updates from content script click
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && activeTabId && changes[`activeInputContext_${activeTabId}`]) {
        updateTargetContext(changes[`activeInputContext_${activeTabId}`].newValue);
      }
    });
  }

  // Listen for chat entries and generating state from content script
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SHOW_CHAT_ENTRY') {
        appendMessage('user', msg.prompt);
        if (msg.error) {
          appendMessage('assistant', `Error: ${msg.error}`);
        } else {
          appendMessage('assistant', msg.response);
        }
        updateEmptyState();
        sendResponse({ success: true });
      }

      if (msg.type === 'INPUT_GENERATING_START') {
        isInputGenerating = true;
        generatingPrompt = msg.prompt || '';
        // Disable chat input and show stop icon (stop button stays ENABLED for cancel)
        userPromptInput.disabled = true;
        userPromptInput.placeholder = 'Generating...';
        sendPromptBtn.disabled = false;
        sendPromptBtn.innerHTML = `<span class="icon-mask icon-stop icon-size-md"></span>`;
        sendResponse({ success: true });
      }

      if (msg.type === 'INPUT_GENERATING_STOP') {
        isInputGenerating = false;
        // Re-enable chat input and show send icon
        userPromptInput.disabled = false;
        userPromptInput.placeholder = 'Ask anything...';
        sendPromptBtn.disabled = !userPromptInput.value.trim() || !activeContext;
        sendPromptBtn.innerHTML = `<span class="icon-mask icon-send icon-size-md"></span>`;
        sendResponse({ success: true });
      }
    });
  }

  clearPreviewBtn.addEventListener('click', () => {
    originalTextPreview.classList.add('hidden');
    if (activeContext) {
      activeContext.currentValue = '';
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && activeTabId) {
        chrome.storage.local.set({ [`activeInputContext_${activeTabId}`]: activeContext });
      }
    }
  });

  loadActiveContext();

  // Listen to tab switches (activation)
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      chrome.windows.getCurrent((currentWindow) => {
        if (activeInfo.windowId === currentWindow.id) {
          const oldTabId = activeTabId;
          activeTabId = activeInfo.tabId;

          // Hide indicators on the old tab
          if (oldTabId) {
            chrome.tabs.sendMessage(oldTabId, { type: 'HIDE_INDICATORS' }).catch(() => { });
          }

          // Load context for the new active tab
          chrome.storage.local.get([`activeInputContext_${activeTabId}`], (res) => {
            updateTargetContext(res[`activeInputContext_${activeTabId}`] || null);
          });

          // Show indicators on the new active tab
          chrome.runtime.sendMessage({ type: 'INJECT_AND_SHOW', tabId: activeTabId }, (res) => {
            if (chrome.runtime.lastError || !res?.success) {
              console.warn('[Content Enhancer] Failed to inject/show on tab change:', chrome.runtime.lastError);
            }
          });
        }
      });
    });
  }

  // Listen to tab updates (loading/complete navigation)
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      chrome.windows.getCurrent((currentWindow) => {
        if (tab.windowId === currentWindow.id && tabId === activeTabId) {
          if (changeInfo.status === 'loading') {
            // Page is starting to load/navigate: clear the context for this tab
            chrome.storage.local.remove(`activeInputContext_${activeTabId}`, () => {
              updateTargetContext(null);
            });
          } else if (changeInfo.status === 'complete') {
            // Page finished loading: re-inject and show indicators
            chrome.runtime.sendMessage({ type: 'INJECT_AND_SHOW', tabId: activeTabId }, (res) => {
              if (chrome.runtime.lastError || !res?.success) {
                console.warn('[Content Enhancer] Failed to inject/show on tab update:', chrome.runtime.lastError);
              }
            });
          }
        }
      });
    });
  }

  // ── Textarea Auto-Resize ───────────────────────────────────────────────────
  userPromptInput.addEventListener('input', () => {
    userPromptInput.style.height = 'auto';
    userPromptInput.style.height = `${userPromptInput.scrollHeight}px`;
    sendPromptBtn.disabled = !userPromptInput.value.trim() || !activeContext;
  });

  userPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendPromptBtn.disabled) sendPromptBtn.click();
    }
  });

  // ── Prompt Submission & AI Query ───────────────────────────────────────────
  sendPromptBtn.addEventListener('click', async () => {
    // If currently generating from input, clicking stop cancels it
    if (isInputGenerating) {
      isInputGenerating = false;
      userPromptInput.disabled = false;
      userPromptInput.placeholder = 'Ask anything...';
      sendPromptBtn.disabled = !userPromptInput.value.trim() || !activeContext;
      sendPromptBtn.innerHTML = `<span class="icon-mask icon-send icon-size-md"></span>`;

      // Immediately append user prompt and termination message in chat
      if (generatingPrompt) {
        appendMessage('user', generatingPrompt);
        appendMessage('assistant', 'Generation terminated.');
        updateEmptyState();
      }

      // Tell content script to cancel generation
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_GENERATION' }).catch(() => { });
        }
      }
      return;
    }

    const prompt = userPromptInput.value.trim();
    if (!prompt) return;

    // Clear user input and reset height
    userPromptInput.value = '';
    userPromptInput.style.height = 'auto';
    sendPromptBtn.disabled = true;

    // Render user bubble
    appendMessage('user', prompt);
    updateEmptyState();

    // Render loading indicator bubble
    const loadingBubble = appendMessage('assistant', '', true);

    try {
      const result = await fetchAIResponse(prompt);

      // Remove loading indicator
      loadingBubble.remove();

      // Render assistant bubble with clean text
      appendMessage('assistant', result);

      // Auto-fill into active input field
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'FILL_ACTIVE_FIELD', value: result }, () => {
            showToast('Text enhanced and filled!');
          });
        }
      } else {
        showToast('Mock text filled successfully!');
      }

      // Hide the current text preview card since the input value has now changed/been filled
      originalTextPreview.classList.add('hidden');
      if (activeContext) {
        activeContext.currentValue = '';
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && activeTabId) {
          chrome.storage.local.set({ [`activeInputContext_${activeTabId}`]: activeContext });
        }
      }
    } catch (err) {
      loadingBubble.remove();
      appendMessage('assistant', `Error: ${err.message}. Please verify your API Settings.`);
    }
    updateEmptyState();
  });

  // Render a standard text message bubble or shimmer loader
  function appendMessage(role, text, isLoading = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;

    const rowDiv = document.createElement('div');
    rowDiv.className = 'message-row';

    const bubble = document.createElement('div');
    if (isLoading) {
      bubble.className = 'bubble shimmer';
      bubble.innerHTML = `<span class="shimmer-loading">Generating answer...</span>`;
    } else {
      bubble.className = 'bubble';
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.textContent = text;
      if (text === 'Generation terminated.') {
        bubble.style.fontStyle = 'italic';
        bubble.style.color = 'var(--ax-fg-secondary)';
      }
    }

    rowDiv.appendChild(bubble);
    msgDiv.appendChild(rowDiv);

    if (!isLoading) {
      // Copy Row (appears on hover)
      const copyRow = document.createElement('div');
      copyRow.className = 'copy-row';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.type = 'button';
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = `<span class="icon-mask icon-copy icon-size-xs"></span>`;

      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.innerHTML = `<span class="icon-mask icon-check icon-size-xs"></span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<span class="icon-mask icon-copy icon-size-xs"></span>`;
          }, 1500);
        });
      });

      copyRow.appendChild(copyBtn);
      msgDiv.appendChild(copyRow);
    }

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return msgDiv;
  }

  function updateEmptyState() {
    const emptyDiv = chatMessages.querySelector('.empty');
    const hasMessages = chatMessages.querySelectorAll('.message').length > 0;
    if (hasMessages) {
      if (emptyDiv) emptyDiv.style.display = 'none';
    } else {
      if (emptyDiv) {
        emptyDiv.style.display = 'flex';
      } else {
        const div = document.createElement('div');
        div.className = 'empty';
        div.innerHTML = `
          <img src="../icons/icon.png" width="40" height="40" style="opacity: 0.85; display: block;" alt="Mascot">
        `;
        chatMessages.appendChild(div);
      }
    }
  }

  // Clear chat button handler
  clearChatBtn.addEventListener('click', () => {
    // Clear all messages except empty state if we want to restore it
    const emptyDiv = chatMessages.querySelector('.empty');
    chatMessages.innerHTML = '';
    if (emptyDiv) {
      emptyDiv.style.display = 'flex';
      chatMessages.appendChild(emptyDiv);
    } else {
      updateEmptyState();
    }
    userPromptInput.value = '';
    userPromptInput.style.height = 'auto';
    sendPromptBtn.disabled = true;
    showToast('Chat cleared');
  });

  // ── API request handler ─────────────────────────────────────────────────────
  async function fetchAIResponse(userPrompt) {
    const provider = currentSettings.aiProvider || 'GEMINI';
    const apiKey = provider === 'GEMINI'
      ? currentSettings.geminiDefaultKey
      : currentSettings.openrouterDefaultKey;
    const modelName = provider === 'GEMINI'
      ? (currentSettings.geminiSelectedModel || 'gemini-1.5-flash')
      : (currentSettings.openrouterSelectedModel || 'openrouter/free');

    if (!apiKey) {
      throw new Error('Please configure an API Key in settings first.');
    }

    const fieldLabel = activeContext?.label || 'Text input';
    const fieldPlaceholder = activeContext?.placeholder || '';
    const existingValue = activeContext?.currentValue || '';

    const systemPrompt = `You are an input field filler. Return ONLY the final raw text to fill the field.
Strict rules:
1. No chat, preamble, notes, explanations, markdown formatting, or quotes.
2. Interpret the user's core intent even if the input is short, fragmented, or has informal/reversed word order.
3. If the intent is to generate mock/random/placeholder data (e.g. email, phone, name, address, number, specific domain mail), generate a highly realistic, professional, and format/country-appropriate random value. Do NOT output generic dummy placeholders unless specifically requested.
4. If the intent is to process, translate, rewrite, or enhance existing text, execute that specific operation directly in a highly polished, professional, and natural manner.

Context:
Label: "${fieldLabel}"
Placeholder: "${fieldPlaceholder}"
Existing: "${existingValue}"`;

    const randomSeed = Math.random().toString(36).substring(7);

    if (provider === 'GEMINI') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            { role: 'user', parts: [{ text: `${userPrompt}\n\n[Seed: ${randomSeed}]` }] }
          ],
          generationConfig: {
            temperature: 1.0
          }
        })
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Gemini API error: ${res.status} - ${txt}`);
      }

      const data = await res.json();
      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return cleanResponseText(responseText);

    } else {
      // OpenRouter
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/vasubhalodiya',
          'X-Title': 'Content Enhancer'
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${userPrompt}\n\n[Seed: ${randomSeed}]` }
          ],
          temperature: 1.0
        })
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`OpenRouter API error: ${res.status} - ${txt}`);
      }

      const data = await res.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      return cleanResponseText(responseText);
    }
  }

  function cleanResponseText(text) {
    let clean = text.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:[a-zA-Z0-9]+)?\n?/, '').replace(/\n?```$/, '');
    }
    // Strip surrounding quotes if AI wrapped the entire response in quotes
    if (clean.startsWith('"') && clean.endsWith('"') && clean.split('"').length === 3) {
      clean = clean.slice(1, -1);
    }
    return clean.trim();
  }
});
