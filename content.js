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
    });
    window.contentEnhancerListenerRegistered = true;
  }

  // ── Global State ───────────────────────────────────────────────────────────
  let indicatorsVisible = false;
  let activeElement = null;
  let indicatorElements = [];
  let lastRightClickedElement = null;

  // Track last right clicked element globally
  document.addEventListener('contextmenu', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      lastRightClickedElement = el;
    } else {
      lastRightClickedElement = null;
    }
  });

  const triggerContextMenuSelect = async () => {
    const el = lastRightClickedElement || document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      if (el.disabled || el.readOnly) return { status: 'ignored' };
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
        placeholder: el.placeholder || '',
        name: el.getAttribute('name') || '',
        idAttr: el.id || '',
        currentValue: el.value || '',
        timestamp: Date.now()
      };

      await chrome.storage.local.set({ activeInputContext: context });
      
      // Auto show indicators if not already visible
      if (!indicatorsVisible) {
        createIndicators();
      }
      el.focus();
      return { status: 'selected' };
    }
    return { status: 'no_target' };
  };

  // Capture context on focus or click automatically
  const handleElementFocus = async (el) => {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    if (el.disabled || el.readOnly) return;
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
      placeholder: el.placeholder || '',
      name: el.getAttribute('name') || '',
      idAttr: el.id || '',
      currentValue: el.value || '',
      timestamp: Date.now()
    };

    await chrome.storage.local.set({ activeInputContext: context });
  };

  document.addEventListener('focusin', (e) => handleElementFocus(e.target));
  document.addEventListener('click', (e) => handleElementFocus(e.target));

  // ── Framework-Resilient Value Setter ───────────────────────────────────────
  const setVal = (el, val) => {
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
            } catch (_) {}
          }
        }
        fiber = fiber.return;
      }
    } catch (_) {}
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
    let offsetRight = pr > 24 ? pr + 4 : 8;

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
      } catch (_) {}
    }
    return offsetRight;
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
    indicatorElements.forEach(ind => {
      try { ind.element.remove(); } catch (_) {}
    });
    indicatorElements = [];
    indicatorsVisible = false;
  };

  // ── Create Indicators ──────────────────────────────────────────────────────
  const createIndicators = () => {
    removeIndicators();

    // Query text inputs and textareas
    const allowedTypes = ['text', 'email', 'url', 'search', 'tel', ''];
    const inputs = Array.from(document.querySelectorAll(
      'input, textarea'
    )).filter(el => {
      if (el.disabled || el.readOnly) return false;
      if (el.tagName === 'INPUT') {
        const type = (el.getAttribute('type') || '').toLowerCase().trim();
        if (!allowedTypes.includes(type)) return false;
      }
      return isVisible(el);
    });

    let idCounter = 1;
    const placedPositions = [];

    inputs.forEach(input => {
      const parent = input.parentElement;
      if (!parent) return;

      const rect = input.getBoundingClientRect();
      const size = 18;
      const offsetRight = getOffsetRight(input);

      // Use absolute viewport coordinates for overlap detection during creation
      const topViewport = rect.top + window.scrollY + (input.tagName === 'TEXTAREA' ? 8 : (rect.height - size) / 2);
      const leftViewport = rect.left + window.scrollX + rect.width - size - offsetRight;

      // Check if we already have a dot within 15px of this position
      const isOverlap = placedPositions.some(pos => {
        const dx = pos.left - leftViewport;
        const dy = pos.top - topViewport;
        return Math.sqrt(dx * dx + dy * dy) < 15;
      });

      if (isOverlap) {
        return; // Skip duplicate / overlapping input
      }

      placedPositions.push({ left: leftViewport, top: topViewport });

      const id = `enhancer_${idCounter++}`;
      input.setAttribute('data-enhancer-id', id);

      // Ensure parent container has positioning context
      try {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.position === 'static') {
          parent.style.position = 'relative';
        }
      } catch (_) {}

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
          placeholder: input.placeholder || '',
          name: input.getAttribute('name') || '',
          idAttr: input.id || '',
          currentValue: input.value || '',
          timestamp: Date.now()
        };

        // Send open side panel message synchronously in event thread to preserve user gesture
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});

        chrome.storage.local.set({ activeInputContext: context });
      });

      parent.appendChild(circle);
      indicatorElements.push({ element: circle, target: input });
    });

    repositionIndicators();
    indicatorsVisible = true;

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
      const checkY = rect.top + (input.tagName === 'TEXTAREA' ? 12 : rect.height / 2);

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
      } catch (_) {}

      circle.style.display = 'block';

      // Position absolute relative to the parent positioned container
      try {
        const isTextarea = input.tagName === 'TEXTAREA';
        const top = isTextarea
          ? input.offsetTop + 8
          : input.offsetTop + (input.offsetHeight - size) / 2;
        const left = input.offsetLeft + input.offsetWidth - size - offsetRight;

        circle.style.top = `${top}px`;
        circle.style.left = `${left}px`;
      } catch (_) {}
    });
  }

  // ── Fill Value into Active Input ──────────────────────────────────────────
  const fillActiveField = (value) => {
    chrome.storage.local.get(['activeInputContext'], (res) => {
      const context = res.activeInputContext;
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
})();
