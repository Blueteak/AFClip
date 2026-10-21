// Runs inside the existing sandbox. Only the parent can enable editing.
(() => {
  let fields = new Map(), overrides = {}, editing = null, enabled = false;
  const selector = '[data-text], [data-afclip-text]';
  const fieldId = el => el.getAttribute('data-text') ?? el.getAttribute('data-afclip-text');
  const send = data => parent.postMessage(data, '*');
  const valueOf = el => {
    const style = el.style.textTransform; el.style.textTransform = 'none';
    const value = el.innerText.replace(/\r\n?/g, '\n'); el.style.textTransform = style;
    return value;
  };
  function apply() {
    for (const [id, field] of fields) {
      if (editing?.id === id) continue;
      const value = Object.hasOwn(overrides, id) ? overrides[id] : field.default;
      if (field.el.textContent !== value) field.el.textContent = value;
    }
  }
  function describe() {
    if (!enabled) return;
    send({ type: 'afclip-text-fields', fields: [...fields].map(([id, {el}]) => {
      const r = el.getBoundingClientRect();
      let visible = r.width > 0 && r.height > 0;
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) visible = false;
      }
      return { id, x: r.x, y: r.y, width: r.width, height: r.height, visible };
    }) });
  }
  function finish(cancel = false) {
    if (!editing) return;
    const { id, el, before, outline, outlinePriority } = editing, value = cancel ? before : valueOf(el);
    editing = null; el.removeAttribute('contenteditable'); if (outline) el.style.setProperty('outline', outline, outlinePriority); else el.style.removeProperty('outline');
    overrides = {...overrides, [id]: value}; el.textContent = value;
    send({ type: 'afclip-text-end', field: id, value, cancel }); describe();
  }
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll(selector)) {
      const id = fieldId(el);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || fields.has(id) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || ['SCRIPT','STYLE','TEXTAREA','INPUT','CANVAS','SVG','TEMPLATE'].includes(el.tagName) || [...el.children].some(c => c.tagName !== 'BR')) {
        fields = new Map(); window.afclipTextError = 'Text fields need unique IDs and plain text'; return;
      }
      const value = [...el.childNodes].map(n => n.nodeName === 'BR' ? '\n' : n.textContent).join('');
      fields.set(id, {el, default: value}); el.style.whiteSpace = 'pre-wrap';
    }
    apply();
    // Render functions may replace field contents. Reapply before the next paint.
    new MutationObserver(() => { apply(); }).observe(document.body, { childList: true, characterData: true, subtree: true });
  });
  // HTML assets apply per-clip text before each render.
  window.AFClipApplyText = text => {
    overrides = text || {};
    const missing = Object.keys(overrides).filter(id => !fields.has(id) || !fields.get(id).el.isConnected);
    if (window.afclipTextError || missing.length) throw new Error(window.afclipTextError || `Missing text field: ${missing.join(', ')}`);
    apply();
  };
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const d = event.data;
    if (d?.type === 'afclip-render') {
      overrides = d.text || {};
      const missing = Object.keys(overrides).filter(id => !fields.has(id) || !fields.get(id).el.isConnected);
      if (window.afclipTextError || missing.length) {
        event.stopImmediatePropagation();
        send({type:'afclip-error',requestId:d.requestId,error:window.afclipTextError || `Missing text field: ${missing.join(', ')}`}); return;
      }
      enabled = d.editable === true;
      apply(); requestAnimationFrame(() => requestAnimationFrame(describe));
    } else if (d?.type === 'afclip-text-edit' && enabled && fields.has(d.field)) {
      finish();
      const {el} = fields.get(d.field);
      editing = {id:d.field, el, before:el.textContent, outline:el.style.getPropertyValue('outline'), outlinePriority:el.style.getPropertyPriority('outline')};
      el.contentEditable = 'plaintext-only'; el.style.outline = '1px solid #75baff'; el.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    } else if (d?.type === 'afclip-text-finish') finish(d.cancel === true);
  }, true);
  document.addEventListener('pointerdown', event => {
    const el = event.target.closest(selector);
    if (editing && el === editing.el) return;
    finish();
    if (enabled && el && fields.get(fieldId(el))?.el === el) {
      event.preventDefault(); send({ type: 'afclip-text-request', field: fieldId(el) });
    }
  });
  document.addEventListener('focusout', () => { if (editing) finish(); });
  document.addEventListener('keydown', event => {
    if (!editing) return;
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); finish(true); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(); }
  }, true);
  document.addEventListener('paste', event => {
    if (!editing) return;
    event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
})();
