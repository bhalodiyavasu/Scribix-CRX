(async () => {
  // Register message listener once
  if (!window.contentEnhancerListenerRegistered) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'PING') {
        sendResponse({ status: 'ok' });
        return true;
      }
      if (msg.type === 'TOGGLE_CIRCLE_ICONS') {
        toggleIndicators();
        sendResponse({ status: 'toggled' });
        return true;
      }
      if (msg.type === 'SHOW_INDICATORS') {
        createIndicators();
        sendResponse({ status: 'shown' });
        return true;
      }
      if (msg.type === 'HIDE_INDICATORS') {
        removeIndicators();
        sendResponse({ status: 'hidden' });
        return true;
      }
      if (msg.type === 'FILL_ACTIVE_FIELD') {
        fillActiveField(msg.value);
        sendResponse({ status: 'filled' });
        return true;
      }
      if (msg.type === 'TRIGGER_CONTEXT_MENU_SELECT') {
        triggerContextMenuSelect().then(sendResponse);
        return true;
      }
      if (msg.type === 'CANCEL_GENERATION') {
        isGenerating = false;
        if (activeElement) {
          setIndicatorLoading(activeElement, false);
          activeElement.readOnly = false;
          activeElement.style.opacity = '';
          activeElement.focus();
        }
        sendResponse({ status: 'cancelled' });
        return true;
      }
    });
    window.contentEnhancerListenerRegistered = true;
  }

  // Fetch tab ID from background
  let tabId = null;
  try {
    const response = await new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, resolve);
      } else {
        resolve(null);
      }
    });
    tabId = response?.tabId;
  } catch (err) {
    console.error('[Content Enhancer] Error fetching tab ID:', err);
  }

  // Helpers to read/write context with tabId
  const saveContext = async (context) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const key = tabId ? `activeInputContext_${tabId}` : 'activeInputContext';
      await chrome.storage.local.set({ [key]: context });
    }
  };

  const getContext = (callback) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const key = tabId ? `activeInputContext_${tabId}` : 'activeInputContext';
      chrome.storage.local.get([key], (res) => {
        callback(res[key] || null);
      });
    } else {
      callback(null);
    }
  };

  // ── Helper Utilities for Rich Text / Custom Editors ────────────────────────
  const getEditableElement = (el) => {
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) return el;
    if (el.getAttribute('role') === 'textbox') return el;

    // Check if it's or is inside editor-critique-card
    const critiqueCard = el.closest('editor-critique-card') || (el.tagName === 'EDITOR-CRITIQUE-CARD' ? el : null);
    if (critiqueCard) {
      const editable = critiqueCard.querySelector('[contenteditable="true"], [role="textbox"], textarea, input');
      if (editable) return editable;
      return critiqueCard;
    }

    return null;
  };

  const isSupportedInputField = (el) => {
    return getEditableElement(el) !== null;
  };

  const setElementReadOnly = (el, readonly) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.readOnly = readonly;
    } else {
      el.contentEditable = readonly ? 'false' : 'true';
    }
    el.style.opacity = readonly ? '0.7' : '';
  };

  // ── Global State ───────────────────────────────────────────────────────────
  let indicatorsVisible = false;
  let activeElement = null;
  let indicatorElements = [];
  let lastRightClickedElement = null;
  let isGenerating = false;

  // Track last right clicked element globally
  document.addEventListener('contextmenu', (e) => {
    const el = getEditableElement(e.target);
    if (el) {
      lastRightClickedElement = el;
    } else {
      lastRightClickedElement = null;
    }
  });

  const triggerContextMenuSelect = async () => {
    const rawEl = lastRightClickedElement || document.activeElement;
    const el = getEditableElement(rawEl);
    if (el) {
      if (el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false') return { status: 'ignored' };
      if (el.tagName === 'INPUT') {
        const type = (el.getAttribute('type') || '').toLowerCase().trim();
        const allowedTypes = ['text', 'email', 'url', 'search', 'tel', ''];
        if (!allowedTypes.includes(type)) return { status: 'ignored' };
      }

      activeElement = el;
      let id = el.getAttribute('data-enhancer-id');
      if (!id) {
        id = `enhancer_${Math.random().toString(36).substring(7)}`;
        el.setAttribute('data-enhancer-id', id);
      }

      const context = {
        elementId: id,
        label: getLabel(el),
        placeholder: el.placeholder || el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        idAttr: el.id || '',
        currentValue: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || ''),
        timestamp: Date.now()
      };

      await saveContext(context);

      // Auto show indicators if not already visible
      if (!indicatorsVisible) {
        createIndicators();
      }
      el.focus();
      return { status: 'selected' };
    }
    return { status: 'no_target' };
  };

  const handleElementFocus = async (rawEl) => {
    const el = getEditableElement(rawEl);
    if (!el) return;
    if (el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false') return;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase().trim();
      const allowedTypes = ['text', 'email', 'url', 'search', 'tel', ''];
      if (!allowedTypes.includes(type)) return;
    }

    activeElement = el;
    let id = el.getAttribute('data-enhancer-id');
    if (!id) {
      id = `enhancer_${Math.random().toString(36).substring(7)}`;
      el.setAttribute('data-enhancer-id', id);
    }

    const context = {
      elementId: id,
      label: getLabel(el),
      placeholder: el.placeholder || el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      idAttr: el.id || '',
      currentValue: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || ''),
      timestamp: Date.now()
    };

    await saveContext(context);
  };

  document.addEventListener('focusin', (e) => handleElementFocus(e.target));
  document.addEventListener('click', (e) => handleElementFocus(e.target));

  const setVal = (el, val) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      try {
        if (nativeSet) nativeSet.call(el, val); else el.value = val;
      } catch (_) { return; }

      // Dispatch input and change events
      ['input', 'change', 'blur'].forEach(type =>
        el.dispatchEvent(new Event(type, { bubbles: true }))
      );

      // React Fiber framework fallback
      try {
        const fk = Object.keys(el).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!fk) return;
        let fiber = el[fk];
        while (fiber) {
          const mp = fiber.memoizedProps;
          if (mp && !mp.options) {
            if (typeof mp.onChange === 'function') {
              mp.onChange({ target: el, currentTarget: el, type: 'change', nativeEvent: new Event('change') });
              break;
            }
            if (mp?.control && typeof mp.name === 'string') {
              try {
                if (typeof mp.control._setFieldValue === 'function') {
                  mp.control._setFieldValue(mp.name, val);
                  mp.control._subjects?.values?.next?.({
                    name: mp.name,
                    values: { ...mp.control._formValues, [mp.name]: val },
                  });
                  break;
                }
              } catch (_) { }
            }
          }
          fiber = fiber.return;
        }
      } catch (_) { }
    } else {
      // Contenteditable or custom element (e.g. Teams, Notion, Slate, etc.)
      el.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        if (!document.execCommand('insertText', false, val)) {
          el.innerText = val;
        }
      } catch (_) {
        el.innerText = val;
      }

      ['input', 'change', 'blur'].forEach(type =>
        el.dispatchEvent(new Event(type, { bubbles: true }))
      );
    }
  };

  // ── Label Resolution Utility ──────────────────────────────────────────────
  const getLabel = el => {
    if (!el) return '';

    // 1. Aria label attributes
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    // 2. Aria-labelledby linked elements
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (txt) return txt;
    }

    // 3. Label tag linking via 'for' attribute
    if (el.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (linked) return linked.textContent.trim();
    }

    // 4. Preceding siblings (spans, divs, labels, or headings containing field titles)
    let prev = el.previousElementSibling;
    while (prev) {
      if (['LABEL', 'SPAN', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(prev.tagName)) {
        const text = prev.textContent.trim().replace(/[:：\s]+$/, '');
        if (text && text.length < 50) return text;
        break;
      }
      prev = prev.previousElementSibling;
    }

    // 5. Parent inline text nodes preceding the element
    let parent = el.parentElement;
    if (parent) {
      let textBefore = "";
      for (let child of parent.childNodes) {
        if (child === el) break;
        if (child.nodeType === Node.TEXT_NODE) {
          textBefore += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (!['SCRIPT', 'STYLE'].includes(child.tagName)) {
            textBefore += child.textContent;
          }
        }
      }
      textBefore = textBefore.trim().replace(/[:：\s]+$/, '');
      if (textBefore && textBefore.length < 50) return textBefore;
    }

    // 6. Containers search (headers, titles, nested label elements)
    let curr = el.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!curr || curr === document.body) break;

      const lbl = curr.querySelector('label');
      if (lbl && lbl !== el) {
        const text = lbl.textContent.trim().replace(/[:：\s]+$/, '');
        if (text && text.length < 50) return text;
      }

      const titleAttr = curr.getAttribute('title');
      if (titleAttr && titleAttr.trim()) return titleAttr.trim();

      const heading = curr.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="label" i]');
      if (heading && heading !== el) {
        const headingText = heading.textContent.trim().replace(/[:：\s]+$/, '');
        if (headingText && headingText.length < 50) return headingText;
      }

      curr = curr.parentElement;
    }

    return '';
  };

  // Check if element is visible
  const isVisible = el => {
    if (!document.contains(el)) return false;

    try {
      const style = getComputedStyle(el);
      if (el.offsetParent === null && style.position !== 'fixed') {
        return false;
      }
    } catch (_) {
      return false;
    }

    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || parseFloat(s.opacity || '1') < 0.1) return false;
      if (s.pointerEvents === 'none') return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();

    // Normal text input/textarea is at least 20px wide and 10px high. Helper/hidden inputs are smaller.
    if (r.width < 20 || r.height < 10) return false;

    // Check absolute left position to ensure it is not off-screen
    const absoluteLeft = r.left + window.scrollX;
    if (absoluteLeft < 0) return false;

    return true;
  };

  // ── Offset Calculation Sibling Auditing Helper ─────────────────────────────
  const getOffsetRight = (input, circle = null) => {
    const style = getComputedStyle(input);
    const pr = parseFloat(style.paddingRight || '0');
    let offsetRight = pr > 28 ? pr + 4 : 12;

    const parent = input.parentElement;
    if (parent) {
      try {
        const inputRight = input.offsetLeft + input.offsetWidth;
        Array.from(parent.children).forEach(sib => {
          if (sib === input || sib === circle || sib.classList.contains('content-enhancer-circle')) {
            return;
          }

          const sibLeft = sib.offsetLeft;
          const sibWidth = sib.offsetWidth;
          const sibRight = sibLeft + sibWidth;

          // If sibling right edge is inside input (within the right 45px of input)
          if (sibRight > inputRight - 45 && sibLeft < inputRight && sibWidth > 0 && sib.offsetHeight > 0) {
            // Check vertical overlap
            const sibTop = sib.offsetTop;
            const sibHeight = sib.offsetHeight;
            const sibBottom = sibTop + sibHeight;
            const inputBottom = input.offsetTop + input.offsetHeight;

            if (sibBottom > input.offsetTop && sibTop < inputBottom) {
              const requiredOffset = inputRight - sibLeft + 4;
              if (requiredOffset > offsetRight) {
                offsetRight = requiredOffset;
              }
            }
          }
        });
      } catch (_) { }
    }
    return offsetRight;
  };

  // ── DOM Mutation Observer ──────────────────────────────────────────────────
  let domObserver = null;
  let domObserverTimeout = null;

  const startDOMObserver = () => {
    if (domObserver) return;

    domObserver = new MutationObserver((mutations) => {
      // Ignore mutations if they are just our own circles being added/removed/updated
      const isOnlySelfMutations = mutations.every(mutation => {
        const target = mutation.target;
        if (target.classList && target.classList.contains('content-enhancer-circle')) return true;
        if (mutation.addedNodes) {
          const addedArr = Array.from(mutation.addedNodes);
          if (addedArr.length > 0 && addedArr.every(n => n.classList && n.classList.contains('content-enhancer-circle'))) return true;
        }
        return false;
      });

      if (isOnlySelfMutations) return;

      // Debounce call to createIndicators
      if (domObserverTimeout) clearTimeout(domObserverTimeout);
      domObserverTimeout = setTimeout(() => {
        if (indicatorsVisible) {
          createIndicators();
        }
      }, 300);
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'disabled', 'readonly']
    });
  };

  const stopDOMObserver = () => {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (domObserverTimeout) {
      clearTimeout(domObserverTimeout);
      domObserverTimeout = null;
    }
  };

  // ── Toggle Indicators ──────────────────────────────────────────────────────
  const toggleIndicators = () => {
    if (indicatorsVisible) {
      removeIndicators();
    } else {
      createIndicators();
    }
  };

  // ── Remove Indicators ──────────────────────────────────────────────────────
  const removeIndicators = () => {
    stopDOMObserver();
    indicatorElements.forEach(ind => {
      try { ind.element.remove(); } catch (_) { }
    });
    indicatorElements = [];
    indicatorsVisible = false;
  };

  // ── Create Indicators ──────────────────────────────────────────────────────
  const createIndicators = () => {
    if (!indicatorsVisible) {
      indicatorsVisible = true;
    }
    startDOMObserver();

    // Query text inputs, textareas, contenteditable, role="textbox", and editor-critique-card
    const allowedTypes = ['text', 'email', 'url', 'search', 'tel', ''];
    const inputs = Array.from(document.querySelectorAll(
      'input, textarea, [contenteditable="true"], [role="textbox"], editor-critique-card'
    )).map(el => getEditableElement(el))
      .filter((el, idx, self) => {
        if (!el) return false;
        if (self.indexOf(el) !== idx) return false; // Deduplicate

        if (el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false') return false;
        if (el.tagName === 'INPUT') {
          const type = (el.getAttribute('type') || '').toLowerCase().trim();
          if (!allowedTypes.includes(type)) return false;
        }
        return isVisible(el);
      });

    // 1. Remove indicators for inputs that are no longer eligible or no longer in DOM
    const currentInputsSet = new Set(inputs);
    indicatorElements = indicatorElements.filter(item => {
      if (!currentInputsSet.has(item.target) || !document.contains(item.target)) {
        try { item.element.remove(); } catch (_) { }
        return false;
      }
      return true;
    });

    // 2. Add indicators for new eligible inputs
    const existingTargets = new Set(indicatorElements.map(item => item.target));
    let idCounter = indicatorElements.length + 1;

    inputs.forEach(input => {
      if (existingTargets.has(input)) return; // Already has indicator

      const parent = input.parentElement;
      if (!parent) return;

      // Ensure parent container has positioning context
      try {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.position === 'static') {
          parent.style.position = 'relative';
        }
      } catch (_) { }

      let id = input.getAttribute('data-enhancer-id');
      if (!id) {
        id = `enhancer_${idCounter++}_${Math.random().toString(36).substring(7)}`;
        input.setAttribute('data-enhancer-id', id);
      }

      const circle = document.createElement('div');
      circle.className = 'content-enhancer-circle';
      circle.style.cssText = `
        position: absolute;
        width: 18px;
        height: 18px;
        cursor: pointer;
        z-index: 10000;
        transition: transform 0.2s ease;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
      `;
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL('icons/logo.svg');
      img.style.cssText = 'display: block; width: 100%; height: 100%;';
      circle.appendChild(img);

      // Hover effect
      circle.addEventListener('mouseenter', () => {
        circle.style.transform = 'scale(1.2)';
      });
      circle.addEventListener('mouseleave', () => {
        circle.style.transform = 'scale(1)';
      });

      // Click event
      circle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        activeElement = input;

        // Visual feedback on click
        circle.style.transform = 'scale(0.9)';
        setTimeout(() => { circle.style.transform = 'scale(1.2)'; }, 100);

        // Save active element context in storage
        const context = {
          elementId: id,
          label: getLabel(input),
          placeholder: input.placeholder || input.getAttribute('placeholder') || '',
          name: input.getAttribute('name') || '',
          idAttr: input.id || '',
          currentValue: (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') ? (input.value || '') : (input.innerText || input.textContent || ''),
          timestamp: Date.now()
        };

        // Send open side panel message synchronously in event thread to preserve user gesture
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => { });

        saveContext(context);
      });

      parent.appendChild(circle);
      indicatorElements.push({ element: circle, target: input });
    });

    repositionIndicators();

    // Listen to resize and scroll
    window.removeEventListener('resize', repositionIndicators);
    window.removeEventListener('scroll', repositionIndicators, true);
    window.addEventListener('resize', repositionIndicators);
    window.addEventListener('scroll', repositionIndicators, true);
  };

  // ── Reposition Indicators ──────────────────────────────────────────────────
  function repositionIndicators() {
    indicatorElements.forEach(item => {
      const input = item.target;
      const circle = item.element;

      if (!input || !document.contains(input) || !isVisible(input)) {
        circle.style.display = 'none';
        return;
      }

      // Check if covered (e.g. scrolled behind a sticky header or off-screen)
      const rect = input.getBoundingClientRect();
      const size = 18;
      const offsetRight = getOffsetRight(input, circle);

      // We evaluate coverage at a point offset to the left of the dot.
      // This guarantees the check falls inside the input box and does not hit the dot itself.
      const checkX = rect.left + rect.width - size - offsetRight - 20;
      const isMultiLine = input.tagName === 'TEXTAREA' || input.tagName === 'DIV' || input.isContentEditable || input.getAttribute('contenteditable') === 'true';
      const checkY = rect.top + (isMultiLine ? 12 : rect.height / 2);

      // If outside the viewport bounds, hide the dot
      if (checkY < 0 || checkY > window.innerHeight || checkX < 0 || checkX > window.innerWidth) {
        circle.style.display = 'none';
        return;
      }

      // Check for sticky headers/navbar coverage using elementFromPoint
      try {
        const ob = document.elementFromPoint(checkX, checkY);
        if (ob && ob !== input && !input.contains(ob) && !ob.contains(input)) {
          const styleOb = getComputedStyle(ob);
          if (styleOb.pointerEvents !== 'none') {
            circle.style.display = 'none';
            return;
          }
        }
      } catch (_) { }

      circle.style.display = 'block';

      // Position absolute relative to the parent positioned container
      try {
        const top = isMultiLine
          ? input.offsetTop + 12
          : input.offsetTop + (input.offsetHeight - size) / 2;
        const left = input.offsetLeft + input.offsetWidth - size - offsetRight;

        circle.style.top = `${top}px`;
        circle.style.left = `${left}px`;
      } catch (_) { }
    });
  }

  // ── Fill Value into Active Input ──────────────────────────────────────────
  const fillActiveField = (value) => {
    getContext((context) => {
      if (!context) return;

      let el = activeElement;
      if (!el || !document.contains(el)) {
        // Fallback search by ID
        el = document.querySelector(`[data-enhancer-id="${context.elementId}"]`);
      }

      if (el) {
        setVal(el, value);
        glow(el);
      }
    });
  };

  // Glow visual highlight
  const glow = (el) => {
    if (!el) return;
    const originalOutline = el.style.outline;
    const originalTransition = el.style.transition;

    el.style.transition = 'outline 0.1s ease';
    el.style.setProperty('outline', `2px solid #4174DA`, 'important');
    el.style.setProperty('outline-offset', '2px', 'important');

    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.transition = originalTransition;
    }, 1200);
  };

  // ── Inject pulse animation stylesheet ─────────────────────────────────────
  if (!document.getElementById('content-enhancer-styles')) {
    const style = document.createElement('style');
    style.id = 'content-enhancer-styles';
    style.textContent = `
      @keyframes content-enhancer-pulse {
        from { transform: scale(1); opacity: 1; }
        to { transform: scale(1.3); opacity: 0.5; }
      }
    `;
    document.head.appendChild(style);
  }

  // Toggle pulse animation on the indicator icon for a given input
  const setIndicatorLoading = (inputEl, isLoading) => {
    if (!inputEl) return;
    const parent = inputEl.parentElement;
    if (!parent) return;
    const circle = parent.querySelector('.content-enhancer-circle');
    if (!circle) return;

    if (isLoading) {
      circle.style.animation = 'content-enhancer-pulse 0.8s infinite alternate';
      circle.style.pointerEvents = 'none';
    } else {
      circle.style.animation = '';
      circle.style.pointerEvents = 'auto';
    }
  };

  // ── AI Call via Background Script ───────────────────────────────────────────
  const fetchAIFromInput = (userPrompt, fieldLabel, fieldPlaceholder, existingValue) => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'GENERATE_AI',
        prompt: userPrompt,
        fieldLabel,
        fieldPlaceholder,
        existingValue
      }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (res?.success) {
          resolve(res.text || '');
        } else {
          reject(new Error(res?.error || 'AI generation failed'));
        }
      });
    });
  };

  const cleanResponseText = (text) => {
    let clean = text.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:[a-zA-Z0-9]+)?\n?/, '').replace(/\n?```$/, '');
    }
    if (clean.startsWith('"') && clean.endsWith('"') && clean.split('"').length === 3) {
      clean = clean.slice(1, -1);
    }
    return clean.trim();
  };

  // ── Real-time input listener to update Current Text in sidepanel ──────────
  document.addEventListener('input', (e) => {
    if (!indicatorsVisible) return;
    const el = getEditableElement(e.target);
    if (!el) return;
    if (el !== activeElement) return;

    // Update the context currentValue and save to storage so sidepanel picks it up
    const key = tabId ? `activeInputContext_${tabId}` : 'activeInputContext';
    chrome.storage.local.get([key], (res) => {
      const ctx = res[key];
      if (ctx) {
        ctx.currentValue = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || '');
        chrome.storage.local.set({ [key]: ctx });
      }
    });
  }, true);

  // ── Intercept Enter key on inputs when extension is active ────────────────

  document.addEventListener('keydown', (e) => {
    if (!indicatorsVisible) return;
    if (e.key !== 'Enter' || e.shiftKey) return;

    const rawEl = e.target;
    const el = getEditableElement(rawEl);
    if (!el) return;
    if (el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false') return;

    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase().trim();
      const allowedTypes = ['text', 'email', 'url', 'search', 'tel', ''];
      if (!allowedTypes.includes(type)) return;
    }

    const prompt = ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : (el.innerText || el.textContent || '')).trim();
    if (!prompt) return;
    if (isGenerating) return;

    // Block form submit
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    isGenerating = true;
    setIndicatorLoading(el, true);

    // Make webpage input read-only during generation to prevent typing
    setElementReadOnly(el, true);

    // Notify sidepanel: generation started (disable chat input, show stop icon, pass prompt)
    chrome.runtime.sendMessage({ type: 'INPUT_GENERATING_START', prompt: prompt }).catch(() => { });

    const label = getLabel(el);
    const placeholder = el.placeholder || el.getAttribute('placeholder') || '';
    const currentValue = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || '');

    fetchAIFromInput(prompt, label, placeholder, currentValue)
      .then((rawResponse) => {
        if (!isGenerating) return; // Exit if cancelled

        const result = cleanResponseText(rawResponse);

        // Remove read-only BEFORE setting value (fixes textarea fill in React)
        setElementReadOnly(el, false);

        setVal(el, result);
        glow(el);

        // Show prompt and response in sidepanel chat
        chrome.runtime.sendMessage({
          type: 'SHOW_CHAT_ENTRY',
          prompt: prompt,
          response: result
        }).catch(() => { });

        // Remove current text preview (update context with empty currentValue)
        const key = tabId ? `activeInputContext_${tabId}` : 'activeInputContext';
        chrome.storage.local.get([key], (res) => {
          const ctx = res[key];
          if (ctx) {
            ctx.currentValue = '';
            chrome.storage.local.set({ [key]: ctx });
          }
        });
      })
      .catch((err) => {
        if (!isGenerating) return; // Exit if cancelled
        console.error('[Content Enhancer] AI error:', err);

        // Show error in sidepanel chat
        chrome.runtime.sendMessage({
          type: 'SHOW_CHAT_ENTRY',
          prompt: prompt,
          error: err.message
        }).catch(() => { });
      })
      .finally(() => {
        if (!isGenerating) return; // Exit if cancelled

        isGenerating = false;
        setIndicatorLoading(el, false);

        // Re-enable the webpage input (in case it wasn't re-enabled in .then)
        setElementReadOnly(el, false);
        el.focus();

        // Notify sidepanel: generation stopped (re-enable chat input, show send icon)
        chrome.runtime.sendMessage({ type: 'INPUT_GENERATING_STOP' }).catch(() => { });
      });
  }, true); // capture phase to intercept before form handlers
})();
