'use strict';
// Agent chats anchored to timeline items, tracks, times or the project.
// Conversations run in the detached controller; the renderer polls their state and draws one glyph per chat
// and at most one popup. Closing the popup never stops an agent.
window.AFClipAgents = host => {
  const { api, h, icon, kbd } = host;
  if (typeof api.agents !== 'function') return null;
  const call = (action, payload = {}) => api.agents(action, payload);

  const PROVIDERS = { claude: { name: 'Claude', mark: 'agent-claude' }, codex: { name: 'Codex', mark: 'agent-codex' } };
  const STATUS = { running: 'Working', waiting: 'Needs input', interrupted: 'Interrupted', error: 'Error', idle: '' };
  const providerName = id => PROVIDERS[id]?.name || id;
  const stamp = v => typeof v === 'number' ? v : Date.parse(v) || 0;
  const sameItem = (a, b) => a.kind === b.kind && a.id === b.id;
  const itemsOf = c => c?.anchor?.items || [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Seen stamps drive unread glyphs; last positions keep a chat in place after its items are deleted.
  const store = (() => {
    const base = { open: null, seen: {}, pos: {} };
    try { return { ...base, ...JSON.parse(localStorage.getItem('afclip.agents') || '{}') }; } catch { return base; }
  })();
  let storeTimer = null;
  const saveStore = () => { clearTimeout(storeTimer); storeTimer = setTimeout(() => localStorage.setItem('afclip.agents', JSON.stringify(store)), 300); };

  let conversations = [], settings = null, providers = null, loaded = false, polling = false;
  let pop = null, sending = false, frame = 0;
  // A poll already in flight must not hide a chat created or revive one settled just now.
  const fresh = new Map(), settled = new Set();
  const glyphs = new Map(), drafts = new Map();
  const layer = h('div', { class: 'agent-layer' });
  document.body.append(layer);
  const dock = document.getElementById('agent-dock');
  const conv = id => conversations.find(c => c.id === id);

  // ------------------------------------------------------------ State
  async function poll() {
    if (polling) return;
    polling = true;
    try { apply(await call('state')); } catch { /* The next tick retries. */ } finally { polling = false; }
  }
  function apply(state) {
    const listed = (state?.conversations || []).filter(c => c.status !== 'settled' && !settled.has(c.id));
    for (const [id, at] of fresh) if (Date.now() - at > 5000 || listed.some(c => c.id === id)) fresh.delete(id);
    const kept = conversations.filter(c => fresh.has(c.id) && !listed.some(o => o.id === c.id));
    conversations = [...listed, ...kept].sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt));
    if (state?.settings) settings = state.settings;
    const live = new Set(conversations.map(c => c.id));
    for (const map of [store.seen, store.pos]) for (const id of Object.keys(map)) if (!live.has(id)) { delete map[id]; saveStore(); }
    if (pop?.id && !live.has(pop.id)) close();
    if (!loaded) {
      loaded = true;
      if (store.open && live.has(store.open)) open(store.open, { focus: false });
    }
    refresh();
  }
  function upsert(c) {
    if (!c?.id) return;
    const i = conversations.findIndex(o => o.id === c.id);
    if (i >= 0) conversations[i] = c; else conversations.push(c);
    refresh();
  }
  function refresh() {
    if (pop?.id) { const c = conv(pop.id); if (c) renderPopup(c); }
    reposition();
  }
  setInterval(poll, 1000);
  void poll();

  // ------------------------------------------------------------ Glyphs
  function mark(provider) {
    const known = PROVIDERS[provider];
    return known ? icon(known.mark, 'agent-mark') : h('span', { class: 'agent-initial' }, String(provider || '?')[0].toUpperCase());
  }
  const unread = c => pop?.id !== c.id && (store.seen[c.id] || 0) < stamp(c.updatedAt);
  function glyphState(c) {
    if (c.status === 'error') return 'error';
    if (c.pending?.length || c.status === 'waiting') return 'input';
    if (c.status === 'running') return 'working';
    if (unread(c)) return 'unread';
    return c.status === 'interrupted' ? 'interrupted' : 'idle';
  }
  function liveLabel(anchor) {
    const items = anchor?.items || [];
    if (items.length === 1) return host.label(items[0]) ?? anchor.label;
    return anchor?.label || 'Chat';
  }
  const gone = anchor => (anchor?.items || []).length > 0 && anchor.items.every(i => host.label(i) == null);
  function glyphFor(c) {
    let el = glyphs.get(c.id);
    if (!el) {
      el = h('button', { class: 'agent-glyph', 'aria-label': 'Agent chat', onclick: e => { e.stopPropagation(); toggle(el.dataset.agent); } });
      el.dataset.agent = c.id;
      el.tip = () => {
        const x = conv(el.dataset.agent); if (!x) return null;
        const last = [...(x.messages || [])].reverse().find(m => m.role === 'assistant' || m.role === 'user');
        return { title: liveLabel(x.anchor), desc: [providerName(x.provider), STATUS[x.status], gone(x.anchor) ? 'Deleted' : ''].filter(Boolean).join(' · '),
          meta: last?.text ? last.text.replace(/\s+/g, ' ').slice(0, 140) : null, hint: [{ keys: '#Click', text: 'open' }, { keys: 'A', text: 'open hovered' }] };
      };
      glyphs.set(c.id, el);
    }
    if (el.dataset.provider !== c.provider) { el.dataset.provider = c.provider; el.replaceChildren(mark(c.provider), h('i', { class: 'agent-badge' })); }
    el.className = `agent-glyph ${glyphState(c)} ${pop?.id === c.id ? 'open' : ''}`;
    return el;
  }
  let draftGlyph = null;
  function placeGlyph(el, loc, placed) {
    if (!loc?.visible) {
      el.classList.add('docked'); el.style.left = el.style.top = '';
      if (el.parentNode !== dock) dock?.append(el);
      return;
    }
    el.classList.remove('docked');
    let { x, y } = loc;
    while (placed.some(p => Math.abs(p.x - x) < 17 && Math.abs(p.y - y) < 17)) x += 20;
    placed.push({ x, y });
    if (el.parentNode !== layer) layer.append(el);
    el.style.left = `${x}px`; el.style.top = `${y}px`;
  }
  // Glyphs follow their items across redraws, scrolls and resizes. Off-screen and project chats sit in the dock.
  function reposition() {
    cancelAnimationFrame(frame); frame = 0;
    const placed = [];
    for (const c of conversations) {
      const el = glyphFor(c);
      const loc = host.project() ? host.locate(c.anchor, store.pos[c.id]) : null;
      if (loc?.pos && itemsOf(c).length && itemsOf(c)[0].kind !== 'project' && !gone(c.anchor)) {
        const pos = JSON.stringify(loc.pos);
        if (JSON.stringify(store.pos[c.id] || null) !== pos) { store.pos[c.id] = loc.pos; saveStore(); }
      }
      placeGlyph(el, loc, placed);
    }
    for (const [id, el] of glyphs) if (!conv(id)) { el.remove(); glyphs.delete(id); }
    if (pop?.draft) {
      draftGlyph ||= h('span', { class: 'agent-glyph draft' });
      if (draftGlyph.dataset.provider !== pop.draft.provider) { draftGlyph.dataset.provider = pop.draft.provider; draftGlyph.replaceChildren(mark(pop.draft.provider)); }
      placeGlyph(draftGlyph, host.project() ? host.locate(pop.draft.anchor) : null, placed);
    } else if (draftGlyph) { draftGlyph.remove(); draftGlyph = null; }
    if (dock) dock.hidden = !dock.children.length;
    host.highlight(pop ? popAnchor().items : null);
    positionPopup();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(reposition); };
  addEventListener('resize', schedule);
  const scroll = document.getElementById('tl-scroll');
  scroll?.addEventListener('scroll', schedule, { passive: true });
  if (scroll) new ResizeObserver(schedule).observe(scroll);

  // ------------------------------------------------------------ Popup
  const popAnchor = () => pop.draft ? pop.draft.anchor : conv(pop.id)?.anchor || { items: [] };
  const draftKey = anchor => JSON.stringify([anchor.kind, anchor.items || [], anchor.trackId || null, anchor.time || null]);
  function toggle(id) { if (pop?.id === id) close(); else open(id); }
  function close() {
    if (!pop) return;
    keepDraft();
    pop.el.remove(); pop = null;
    store.open = null; saveStore();
    reposition();
  }
  function keepDraft() {
    if (!pop) return;
    const key = pop.id || draftKey(pop.draft.anchor), text = pop.textarea.value;
    if (text || pop.images.length) drafts.set(key, { text, images: pop.images }); else drafts.delete(key);
  }
  function open(id, { focus = true } = {}) {
    const c = conv(id); if (!c) return;
    build({ id });
    store.open = id; store.seen[id] = stamp(c.updatedAt); saveStore();
    renderPopup(c);
    reposition();
    if (focus) setTimeout(() => pop?.textarea.focus(), 0);
  }
  function openDraft(anchor) {
    build({ draft: { anchor, provider: settings?.lastProvider || 'claude' } });
    renderPopup(null);
    reposition();
    setTimeout(() => pop?.textarea.focus(), 0);
    if (!providers) loadProviders().then(() => { if (pop?.draft) { pop.headSig = ''; renderHead(null); } }, () => {});
  }
  function build(state) {
    if (pop) { keepDraft(); pop.el.remove(); }
    host.hideTip();
    const head = h('div', { class: 'popover-heading agent-head' });
    const error = h('div', { class: 'agent-error', hidden: true });
    const transcript = h('div', { class: 'agent-transcript' });
    const pending = h('div', { class: 'agent-pending' });
    const thumbs = h('div', { class: 'agent-thumbs', hidden: true });
    const textarea = h('textarea', { class: 'agent-input', rows: 1, spellcheck: 'true', 'aria-label': 'Message' });
    const send = h('button', { class: 'icon-button agent-send', onclick: () => submit(), tip: { title: 'Send', keys: 'Enter', desc: 'Shift+Enter adds a line. Paste images to attach them.' } }, icon('send'));
    const composer = h('div', { class: 'agent-composer' }, thumbs, h('div', { class: 'agent-input-row' }, textarea, send));
    const el = h('div', { class: 'marker-popover agent-popover', role: 'dialog', 'aria-label': 'Agent chat' }, head, error, transcript, pending, composer);
    pop = { ...state, el, head, error, transcript, pending, composer, textarea, thumbs, send, images: [], expanded: new Set(), sig: '', headSig: '', stick: true };
    const saved = drafts.get(state.id || draftKey(state.draft.anchor));
    if (saved) { textarea.value = saved.text; pop.images = [...saved.images]; }
    textarea.oninput = () => grow(textarea);
    textarea.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    };
    textarea.onpaste = e => {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
      addImages(files);
    };
    composer.ondragover = e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    composer.ondrop = e => {
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault(); addImages(files);
    };
    // Timeline shortcuts stay out of the chat; Escape closes it.
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') return;
      e.stopPropagation();
    });
    el.style.left = `${Math.max(10, innerWidth / 2 - 190)}px`; el.style.top = `${Math.max(10, innerHeight / 2 - 220)}px`;
    document.body.append(el);
    renderThumbs(); grow(textarea);
  }
  function grow(textarea) {
    textarea.style.height = 'auto';
    const full = textarea.scrollHeight + 2;
    textarea.style.height = `${Math.min(140, full)}px`; textarea.style.overflowY = full > 140 ? 'auto' : 'hidden';
  }

  function addImages(files) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { host.say(`${file.name || 'Image'} is over 20 MB`, 'warn'); continue; }
      const reader = new FileReader(), target = pop;
      reader.onload = () => {
        if (pop !== target) return;
        pop.images.push({ dataUrl: String(reader.result), name: file.name || `pasted-${pop.images.length + 1}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` });
        renderThumbs();
      };
      reader.readAsDataURL(file);
    }
  }
  function renderThumbs() {
    pop.thumbs.hidden = !pop.images.length;
    pop.thumbs.replaceChildren(...pop.images.map((img, i) => h('span', { class: 'agent-thumb', tip: { title: img.name } }, h('img', { src: img.dataUrl, alt: '' }),
      h('button', { class: 'agent-thumb-x', 'aria-label': 'Remove image', onclick: () => { pop.images.splice(i, 1); renderThumbs(); positionPopup(); } }, icon('x')))));
    positionPopup();
  }

  function renderPopup(c) {
    renderHead(c);
    const delivery = settings?.providers?.[c?.provider]?.delivery || 'steer';
    pop.textarea.placeholder = !c ? `Ask ${providerName(pop.draft.provider)}` : c.status === 'running' || c.status === 'waiting' ? (delivery === 'queue' ? 'Queue a message' : 'Steer') : c.status === 'interrupted' ? 'Resume' : 'Message';
    if (!c) { pop.transcript.hidden = true; pop.pending.hidden = true; pop.error.hidden = true; positionPopup(); return; }
    store.seen[c.id] = stamp(c.updatedAt); saveStore();
    const last = c.messages?.at(-1);
    const sig = JSON.stringify([c.updatedAt, c.status, c.messages?.length, last?.id, last?.text?.length, last?.queued, (c.pending || []).map(p => p.id), c.error || null, [...pop.expanded]]);
    if (sig === pop.sig) return;
    pop.sig = sig;
    const err = c.error ? String(c.error.message || c.error) : '';
    pop.error.hidden = !err; pop.error.replaceChildren(icon('alert', 'sm'), h('span', {}, err));
    renderTranscript(c);
    renderPending(c);
    positionPopup();
  }
  function renderHead(c) {
    const anchor = c ? c.anchor : pop.draft.anchor, status = c?.status || 'draft';
    const sig = JSON.stringify([status, c?.provider || pop.draft?.provider, liveLabel(anchor), gone(anchor), !!providers, settings?.lastProvider]);
    if (sig === pop.headSig) return;
    pop.headSig = sig;
    const title = h('button', { class: `agent-title ${gone(anchor) ? 'gone' : ''}`, onclick: () => host.reveal(anchor),
      tip: { title: liveLabel(anchor), desc: gone(anchor) ? 'Deleted. The chat stays where it was.' : 'Select on the timeline' } }, liveLabel(anchor));
    const lead = c ? h('span', { class: `agent-lead ${glyphState(c)}`, dataset: { provider: c.provider }, tip: { title: providerName(c.provider), desc: 'Provider is fixed for this chat.' } }, mark(c.provider)) : providerPicker();
    const busy = c && (c.status === 'running' || c.status === 'waiting');
    pop.head.replaceChildren(...[lead, title,
      STATUS[status] ? h('span', { class: `agent-status ${status}` }, STATUS[status]) : null,
      busy ? h('button', { class: 'icon-button small', onclick: () => act('stop', c.id), tip: { title: 'Stop', desc: 'Interrupt the agent. Send a message to resume.' } }, icon('stop')) : null,
      c && !busy ? h('button', { class: 'icon-button small', onclick: () => settle(c.id), tip: { title: 'Settle', desc: 'Done with this chat. Removes it, its transcript and images, and frees its items.' } }, icon('check')) : null,
      h('button', { class: 'icon-button small', onclick: () => openSettings(), tip: { title: 'Agent settings' } }, icon('sliders')),
      h('button', { class: 'icon-button small', onclick: () => close(), tip: { title: 'Close', keys: 'Escape', desc: c ? 'The agent keeps working.' : null } }, icon('x'))].filter(Boolean));
  }
  function providerPicker() {
    const box = h('span', { class: 'agent-picker' });
    for (const id of Object.keys(PROVIDERS)) {
      const info = providers?.find(p => p.id === id), missing = info && !info.installed;
      box.append(h('button', { class: `agent-lead ${pop.draft.provider === id ? 'on' : ''}`, dataset: { provider: id }, disabled: missing,
        onclick: () => { pop.draft.provider = id; pop.headSig = ''; renderPopup(null); reposition(); },
        tip: { title: providerName(id), desc: missing ? info.setup : info?.authenticated === false ? `Sign in needed. ${info.setup || ''}` : null, meta: info?.version || null } }, mark(id)));
    }
    return box;
  }
  function renderTranscript(c) {
    const box = pop.transcript;
    box.hidden = !(c.messages || []).length && c.status !== 'running';
    const atBottom = pop.stick || box.scrollHeight - box.scrollTop - box.clientHeight < 32;
    const rows = [], turn = [];
    const flush = () => {
      if (!turn.length) return;
      const latest = turn.findLast(m => m.role === 'assistant');
      const activity = turn.filter(m => m.role === 'tool' || m.role === 'thinking' || (m.role === 'assistant' && m !== latest));
      if (activity.length) {
        const id = `activity:${turn[0].id}`, open = pop.expanded.has(id);
        rows.push(h('div', { class: `agent-tool ${open ? 'open' : ''}` },
          h('button', { class: 'agent-tool-line', 'aria-expanded': String(open), onclick: () => {
            open ? pop.expanded.delete(id) : pop.expanded.add(id); renderPopup(c);
          } }, icon('command', 'sm'), h('span', {}, 'Activity'), icon('chevron-down', 'sm agent-chevron')),
          open ? h('div', { class: 'agent-tool-detail' }, activity.map(m => message(m))) : null));
      }
      for (const m of turn) if (m === latest || !activity.includes(m)) rows.push(message(m));
      turn.length = 0;
    };
    for (const m of c.messages || []) {
      if (m.role === 'user') { flush(); rows.push(message(m)); }
      else turn.push(m);
    }
    flush();
    if (c.status === 'running') rows.push(h('div', { class: 'agent-working' }, h('i'), h('i'), h('i')));
    box.replaceChildren(...rows);
    if (atBottom) box.scrollTop = box.scrollHeight;
    pop.stick = false;
  }
  function message(m) {
    const images = (m.images || []).map(img => img.dataUrl ? h('img', { class: 'agent-msg-image', src: img.dataUrl, alt: img.name || '', tip: { title: img.name || 'Image' } }) : h('span', { class: 'agent-msg-file' }, icon('image', 'sm'), img.name || 'Image'));
    if (m.role === 'tool') {
      const text = String(m.text || ''), first = text.split('\n', 1)[0], open = pop.expanded.has(m.id);
      return h('div', { class: `agent-tool ${open ? 'open' : ''}` },
        h('button', { class: 'agent-tool-line', onclick: () => { open ? pop.expanded.delete(m.id) : pop.expanded.add(m.id); const c = conv(pop.id); if (c) renderPopup(c); } },
          icon('command', 'sm'), h('span', {}, first || 'Tool'), icon('chevron-down', 'sm agent-chevron')),
        open ? h('pre', { class: 'agent-tool-detail' }, text) : null);
    }
    return h('div', { class: `agent-msg ${m.role} ${m.queued ? 'queued' : ''} ${m.cancelled ? 'cancelled' : ''}` },
      images.length ? h('div', { class: 'agent-msg-images' }, images) : null,
      m.text ? h('div', { class: 'agent-msg-text' }, m.text) : null,
      m.queued ? h('span', { class: 'agent-queued', tip: { title: 'Queued', desc: 'Sent when the current turn finishes.' } }, 'Queued') : null);
  }

  // ------------------------------------------------------------ Native questions and approvals
  const pretty = text => { try { const v = JSON.parse(text); return typeof v === 'object' && v ? JSON.stringify(v, null, 2) : String(text); } catch { return String(text); } };
  const optLabel = o => typeof o === 'string' ? o : o?.label ?? o?.id ?? String(o);
  const optValue = o => typeof o === 'string' ? o : o?.id ?? o?.label;
  function renderPending(c) {
    const list = c.pending || [];
    pop.pending.hidden = !list.length;
    const focused = pop.pending.contains(document.activeElement);
    pop.pending.replaceChildren(...list.map(p => request(c, p)));
    if (focused || (list.length && document.activeElement === pop.textarea && !pop.textarea.value)) pop.pending.querySelector('input, button')?.focus();
  }
  function request(c, p) {
    const respond = async (answer, box) => {
      for (const b of box.querySelectorAll('button, input')) b.disabled = true;
      try { upsert(await call('respond', { id: c.id, requestId: p.id, answer })); } catch (error) { host.report(error, 'Answer not sent'); for (const b of box.querySelectorAll('button, input')) b.disabled = false; }
    };
    const box = h('div', { class: `agent-request ${p.kind}` },
      h('div', { class: 'agent-request-title' }, icon(p.kind === 'approval' ? 'lock' : 'help', 'sm'), h('span', {}, p.title || (p.kind === 'approval' ? 'Approval needed' : 'Question'))),
      p.detail ? h('pre', { class: 'agent-request-detail' }, pretty(p.detail)) : null);
    const questions = Array.isArray(p.questions) ? p.questions : Array.isArray(p.questions?.questions) ? p.questions.questions : null;
    if (questions?.length) {
      const picks = questions.map(() => new Set()), others = [];
      questions.forEach((q, qi) => {
        const multi = !!(q.multiSelect ?? q.multiple);
        const opts = h('div', { class: 'agent-options' }, (q.options || []).map(o => {
          const b = h('button', { class: 'chip-button', tip: o?.description ? { title: optLabel(o), desc: o.description } : null, onclick: () => {
            const set = picks[qi], v = optValue(o);
            if (multi) set.has(v) ? set.delete(v) : set.add(v); else { set.clear(); set.add(v); }
            for (const x of opts.children) x.classList.toggle('on', set.has(x.value));
          } }, optLabel(o));
          b.value = optValue(o);
          return b;
        }));
        const other = h('input', { class: 'agent-answer', placeholder: q.options?.length ? 'Other' : 'Answer', spellcheck: 'true' });
        other.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submitAll(); } };
        others.push(other);
        box.append(h('div', { class: 'agent-question' }, q.header && q.question ? h('div', { class: 'agent-q-head' }, q.header) : null, h('div', { class: 'agent-q-text' }, q.question || q.header || q.label || ''), q.options?.length ? opts : null, other));
      });
      const submitAll = () => {
        const answer = {};
        questions.forEach((q, qi) => {
          const key = q.id ?? q.question ?? q.header ?? String(qi), typed = others[qi].value.trim(), multi = !!(q.multiSelect ?? q.multiple);
          answer[key] = typed || (multi ? [...picks[qi]] : [...picks[qi]][0] ?? '');
        });
        respond(answer, box);
      };
      box.append(h('div', { class: 'agent-request-actions' }, h('button', { class: 'btn primary', onclick: submitAll }, 'Answer')));
    } else if (p.options?.length) {
      box.append(h('div', { class: 'agent-request-actions' }, p.options.map((o, i) => h('button', { class: `btn ${i === 0 ? 'primary' : ''}`, onclick: () => respond(optValue(o), box) }, optLabel(o)))));
    } else {
      const input = h('input', { class: 'agent-answer', placeholder: 'Answer', spellcheck: 'true' });
      const go = () => input.value.trim() && respond(input.value.trim(), box);
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      box.append(h('div', { class: 'agent-request-actions' }, input, h('button', { class: 'btn primary', onclick: go }, 'Answer')));
    }
    return box;
  }

  // ------------------------------------------------------------ Actions
  async function submit() {
    if (!pop || sending) return;
    const text = pop.textarea.value.trim(), images = pop.images.map(({ dataUrl, name }) => ({ dataUrl, name }));
    if (!text && !images.length) return;
    const target = pop;
    sending = true; target.send.disabled = true;
    try {
      let id = target.id;
      if (!id) {
        const { anchor, provider } = target.draft;
        const created = await call('create', { provider, anchor, context: host.context(anchor) });
        if (settings?.lastProvider !== provider) void call('settings', { lastProvider: provider }).then(s => { if (s) settings = s; }).catch(() => {});
        drafts.delete(draftKey(anchor));
        store.seen[created.id] = stamp(created.updatedAt);
        fresh.set(created.id, Date.now());
        upsert(created);
        if (pop === target) { target.id = created.id; target.draft = null; target.headSig = ''; store.open = created.id; saveStore(); }
        id = created.id;
      }
      const c = conv(id);
      if (pop === target) { target.textarea.value = ''; target.images = []; renderThumbs(); grow(target.textarea); target.stick = true; }
      drafts.delete(id);
      try { upsert(await call('send', { id, text, images, context: host.context(c?.anchor) })); }
      catch (error) {
        if (pop === target && !target.textarea.value) { target.textarea.value = text; target.images = images; renderThumbs(); grow(target.textarea); }
        throw error;
      }
    } catch (error) { host.report(occupied(error), 'Message not sent'); }
    finally { sending = false; target.send.disabled = false; if (pop === target) { refresh(); target.textarea.focus(); } }
  }
  // Busy-item errors name IDs; show the chats that hold them.
  function occupied(error) {
    const raw = String(error?.message || error);
    const holders = conversations.filter(c => raw.includes(c.id) || itemsOf(c).some(i => raw.includes(i.id)));
    return holders.length ? new Error(`${raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')} · In chat: ${holders.map(c => liveLabel(c.anchor)).join(', ')}`) : error;
  }
  async function act(action, id) {
    try { const result = await call(action, { id }); if (result?.id) upsert(result); else void poll(); } catch (error) { host.report(error, action === 'stop' ? 'Not stopped' : 'Not done'); }
  }
  async function settle(id) {
    try {
      await call('settle', { id });
      settled.add(id);
      conversations = conversations.filter(c => c.id !== id);
      drafts.delete(id); delete store.seen[id]; delete store.pos[id]; saveStore();
      if (pop?.id === id) close(); else reposition();
    } catch (error) { host.report(error, 'Chat not settled'); }
  }

  // A on the hovered glyph, item, track or time; elsewhere on the selection or the project.
  function openTarget() {
    const p = host.pointer(), el = document.elementFromPoint(p.x, p.y);
    const g = el?.closest?.('.agent-glyph[data-agent]');
    if (g) { toggle(g.dataset.agent); return; }
    if (pop && pop.el.contains(el)) { pop.textarea.focus(); return; }
    openAnchor(host.target(), true);
  }
  function openAnchor(anchor, toggleExisting = false) {
    if (!anchor) return;
    const p = host.pointer();
    const items = anchor.items || [];
    const holders = conversations.filter(c => itemsOf(c).some(i => items.some(t => sameItem(i, t))));
    if (!holders.length) { if (toggleExisting && pop?.draft && draftKey(pop.draft.anchor) === draftKey(anchor)) close(); else openDraft(anchor); return; }
    if (holders.length === 1 && items.every(t => itemsOf(holders[0]).some(i => sameItem(i, t)))) { toggleExisting ? toggle(holders[0].id) : open(holders[0].id); return; }
    const free = items.filter(t => !holders.some(c => itemsOf(c).some(i => sameItem(i, t))));
    host.openMenu([
      ...holders.map(c => ({ label: liveLabel(c.anchor), icon: 'chat', run: () => open(c.id) })),
      ...(free.length ? ['-', { label: `New chat · ${free.length === 1 ? host.label(free[0]) || '1 item' : plural(free.length, 'item')}`, icon: 'plus', run: () => openDraft(host.anchor(free)) }] : []),
    ], p.x, p.y);
  }

  function positionPopup() {
    if (!pop) return;
    const box = pop.el, glyph = pop.id ? glyphs.get(pop.id) : draftGlyph;
    const r = glyph?.isConnected ? glyph.getBoundingClientRect() : null;
    if (!r || !r.width) { box.classList.add('no-tip'); return; }
    box.classList.remove('no-tip');
    const above = r.top - 18, below = innerHeight - r.bottom - 18;
    const down = above < 420 && below > above;
    box.style.maxHeight = `${Math.max(180, Math.min(560, down ? below : above))}px`;
    const w = box.offsetWidth, ht = box.offsetHeight, cx = r.left + r.width / 2;
    const left = Math.max(10, Math.min(innerWidth - w - 10, cx - w / 2));
    box.classList.toggle('below', down);
    box.style.left = `${left}px`;
    box.style.top = `${down ? r.bottom + 10 : Math.max(10, r.top - ht - 10)}px`;
    box.style.setProperty('--popover-tip', `${Math.max(14, Math.min(w - 14, cx - left))}px`);
  }
  document.addEventListener('keydown', e => {
    if (!pop || e.key !== 'Escape' || host.blocked()) return;
    if (!pop.el.contains(document.activeElement) && host.hasSelection()) return;
    e.preventDefault(); e.stopImmediatePropagation(); close();
  }, true);

  // ------------------------------------------------------------ Live GUI context
  let contextTimer = null, lastContext = '';
  function contextChanged() {
    if (contextTimer) return;
    contextTimer = setTimeout(() => {
      contextTimer = null;
      const context = host.context(null); if (!context) return;
      const { capturedAt, ...rest } = context, key = JSON.stringify(rest);
      if (key === lastContext) return;
      lastContext = key;
      call('context', { context }).catch(() => { lastContext = ''; });
    }, 300);
  }

  // ------------------------------------------------------------ Settings
  async function loadProviders() {
    try { providers = await call('providers'); } catch (error) { providers = null; throw error; }
    return providers;
  }
  async function openSettings() {
    const body = h('div', { class: 'dialog-body agent-settings' }, h('div', { class: 'empty-note' }, 'Checking providers…'));
    let flush = () => {};
    host.dialog({ title: 'Agents', iconName: 'chat', body, buttons: [{ label: 'Done', kind: 'primary', keys: 'Enter', run: () => flush() }] });
    try {
      await Promise.all([loadProviders(), settings ? null : poll()]);
    } catch (error) { body.replaceChildren(h('div', { class: 'empty-note' }, host.explain(error))); return; }
    if (!body.isConnected) return;
    const save = async partial => {
      try { const next = await call('settings', partial); if (next) settings = next; } catch (error) { host.report(error, 'Setting not saved'); }
      return settings;
    };
    const select = (options, value, onPick) => {
      const s = h('select', { onchange: () => onPick(s.value) }, options.map(([v, label]) => h('option', { value: v }, label)));
      s.value = options.some(([v]) => v === value) ? value : '';
      return s;
    };
    const render = () => {
      flush = () => {};
      const all = settings?.providers || {};
      const rows = [host.field('New chats', host.segmented(Object.keys(PROVIDERS).map(id => [id, providerName(id)]), settings?.lastProvider || 'claude', v => save({ lastProvider: v }).then(render)), { tip: 'Provider picked for new chats. Each chat keeps its provider.' })];
      for (const p of providers || []) {
        const mine = all[p.id] || {}, patch = part => save({ providers: { [p.id]: part } }).then(render);
        const state = !p.installed ? 'Not installed' : p.error ? 'Error' : p.authenticated === false ? 'Sign in needed' : 'Ready';
        const status = h('span', { class: `agent-provider-state ${state === 'Ready' ? 'ok' : 'warn'}`, tip: { title: state, desc: p.setup || null, meta: [p.version, p.error].filter(Boolean).join('\n') || null } }, state);
        const exe = h('input', { value: mine.executable || '', placeholder: 'Default', spellcheck: 'false' });
        let exeTimer = null;
        const commitExe = () => { clearTimeout(exeTimer); exeTimer = null; if (exe.value.trim() !== (mine.executable || '')) void save({ providers: { [p.id]: { executable: exe.value.trim() } } }); };
        exe.oninput = () => { clearTimeout(exeTimer); exeTimer = setTimeout(commitExe, 600); };
        exe.onchange = commitExe;
        const prevFlush = flush; flush = () => { prevFlush(); if (exeTimer) commitExe(); };
        const model = (p.models || []).find(m => m.id === mine.model);
        const efforts = model ? model.efforts || [] : [...new Set((p.models || []).flatMap(m => m.efforts || []))];
        rows.push(h('div', { class: 'agent-provider-head', dataset: { provider: p.id } }, mark(p.id), h('span', { class: 'grow' }, p.name || providerName(p.id)), status),
          host.field('Executable', exe, { tip: 'Optional path to the CLI. Blank uses the installed one.' }),
          host.field('Model', select([['', 'Default'], ...(p.models || []).map(m => [m.id, m.label || m.id])], mine.model || '', v => patch({ model: v, effort: '' })), { tip: 'Default uses the provider’s own default. Applies to new chats.' }),
          efforts.length ? host.field('Thinking', select([['', 'Default'], ...efforts.map(e => [e, e[0].toUpperCase() + e.slice(1)])], mine.effort || '', v => patch({ effort: v })), { tip: 'Reasoning effort for new chats.' }) : null,
          (p.accessModes || []).length ? host.field('Access', select([['', 'Full access (default)'], ...p.accessModes.map(a => [a.id, a.label || a.id])], mine.access || '', v => patch({ access: v })), { tip: 'What the agent may do without asking. Applies to new chats.' }) : null,
          host.field('While busy', host.segmented([['steer', 'Steer', 'A new message redirects the running turn.'], ['queue', 'Queue', 'A new message waits for the running turn to finish.']], mine.delivery || 'steer', v => patch({ delivery: v })), { tip: 'Applies to the next message in every chat.' }));
      }
      body.replaceChildren(...rows.filter(Boolean));
    };
    render();
  }

  return {
    available: () => true,
    openTarget, openAnchor, openSettings, reposition, contextChanged,
    holdsReload: () => sending || !!(pop && (pop.textarea.value || pop.images.length)),
  };
};
