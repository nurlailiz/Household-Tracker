import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { firebaseConfig, USERNAME_DOMAIN } from './firebase-config.js';
import { APP_VERSION } from './version.js';

const versionTag = `<footer class="app-version">Our Home · V${APP_VERSION}</footer>`;

// ============================================================
// Helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toISO(new Date());
const thisMonth = () => today().slice(0, 7);
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const fmtDate = (s) => s ? parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtShort = (s) => s ? parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const fmtMonth = (m) => parseDate(m + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shiftMonth = (m, n) => { const d = parseDate(m + '-01'); d.setMonth(d.getMonth() + n); return toISO(d).slice(0, 7); };
const daysUntil = (s) => Math.round((parseDate(s) - parseDate(today())) / 864e5);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

function money(n) {
  const cur = S.db?.settings?.currency || '$';
  const v = Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '−' : '') + cur + v;
}

function age(birthday) {
  if (!birthday) return '';
  const b = parseDate(birthday), n = new Date();
  let months = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth();
  if (n.getDate() < b.getDate()) months--;
  if (months < 0) return '';
  if (months < 12) return `${months} mo`;
  const y = Math.floor(months / 12), m = months % 12;
  return m ? `${y} yr ${m} mo` : `${y} yr`;
}

const CAT_COLORS = ['#e08a5c', '#6b8fd6', '#9b7bd1', '#4fa58a', '#d16b8f', '#c9a13b', '#5f9fb8'];
function avatar(cat, cls = '') {
  if (cat.photo) return `<img class="avatar ${cls}" src="${esc(cat.photo)}" alt="">`;
  return `<span class="avatar ${cls}" style="background:${catColor(cat)}">${esc(cat.name[0]?.toUpperCase() || '?')}</span>`;
}

function dueBadge(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0) return `<span class="badge danger">Overdue ${-d}d</span>`;
  if (d === 0) return `<span class="badge danger">Due today</span>`;
  if (d <= 14) return `<span class="badge warn">In ${d} day${d === 1 ? '' : 's'}</span>`;
  return `<span class="badge">${fmtDate(dateStr)}</span>`;
}

// ---------- Who changed what ----------
function ago(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 172800) return 'yesterday';
  if (secs < 604800) return `${Math.floor(secs / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function personColor(name) {
  let h = 7; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CAT_COLORS[(h + 3) % CAT_COLORS.length];
}
const personDot = (name) => `<i class="person" style="background:${personColor(name)}" aria-hidden="true">${esc(String(name)[0]?.toUpperCase() || '?')}</i>`;

const wasEdited = (item) => item.updatedBy && item.updatedAt && item.updatedAt !== item.createdAt;

// Short "Added by X · 2h ago" / "Updated by Y · 5m ago" line for list items.
function byline(item, verb) {
  if (!item) return '';
  const edited = wasEdited(item);
  const who = edited ? item.updatedBy : item.createdBy;
  if (!who) return '';
  const action = verb || (edited ? 'Updated' : 'Added');
  return `<span class="by">${personDot(who)}${action} by ${esc(who)} · ${ago(edited ? item.updatedAt : item.createdAt)}</span>`;
}

// Fuller history shown at the top of edit forms.
function history(item) {
  if (!item?.createdBy) return '';
  let h = `<span class="by">${personDot(item.createdBy)}Added by ${esc(item.createdBy)} · ${ago(item.createdAt)}</span>`;
  if (wasEdited(item)) h += `<span class="by">${personDot(item.updatedBy)}Last updated by ${esc(item.updatedBy)} · ${ago(item.updatedAt)}</span>`;
  return `<div class="history">${h}</div>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('actionable');
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

// A toast with a button (e.g. Undo), shown a little longer.
function toastAction(msg, label, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast-btn">${esc(label)}</button>`;
  t.classList.add('show', 'actionable');
  $('.toast-btn', t).onclick = () => { t.classList.remove('show', 'actionable'); fn(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show', 'actionable'), 5000);
}

// ============================================================
// Firebase
// ============================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// The local cache keeps the app usable offline; changes sync when you're back online.
const fdb = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// Usernames are turned into Firebase email logins: "nurlaili" -> "nurlaili@<USERNAME_DOMAIN>".
const toEmail = (u) => (u.includes('@') ? u : `${u}@${USERNAME_DOMAIN}`).trim().toLowerCase();
const displayName = (user) => {
  const n = (user.displayName || user.email.split('@')[0]);
  return n.charAt(0).toUpperCase() + n.slice(1);
};

// ============================================================
// State & data
// ============================================================
const S = {
  me: null,
  db: null,
  tab: store.get('tab', 'home'),
  moneyWho: store.get('moneyWho', 'me'),
  catId: store.get('catId', null),
  periodOffset: 0, // Money: 0 = current budget period, -1 = the one before, …
};

// Field types per collection: used to clean form values before saving.
const SCHEMA = {
  cats: { name: 'str!', breed: 'str', sex: 'str', birthday: 'str', color: 'str', microchip: 'str', notes: 'str', photo: 'str',
    fivFelv: 'str', fivFelvDate: 'str', vaccineStatus: 'str', adopted: 'str' },
  weights: { catId: 'str!', date: 'str!', kg: 'num!', notes: 'str' },
  feedings: { catId: 'str!', time: 'str!', food: 'str', amount: 'str', notes: 'str' },
  events: { catId: 'str!', type: 'str!', date: 'str!', nextDue: 'str', notes: 'str' },
  transactions: { type: 'str!', amount: 'num!', month: 'str!', date: 'str', category: 'str', description: 'str', location: 'str', person: 'str', pocket: 'str', source: 'str' },
  groceries: { name: 'str!', quantity: 'str', note: 'str', addedDate: 'str!', bought: 'bool', boughtDate: 'str', boughtBy: 'str', expiry: 'str' },
};
const COLLECTIONS = Object.keys(SCHEMA);
const CAT_CHILDREN = ['weights', 'feedings', 'events'];

function clean(col, input, partial) {
  const out = {};
  for (const [field, spec] of Object.entries(SCHEMA[col])) {
    const type = spec.replace('!', ''), required = spec.endsWith('!');
    let v = input[field];
    if (v === undefined) {
      if (required && !partial) throw new Error(`${field} is required`);
      continue;
    }
    if (type === 'num') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`${field} must be a number`);
    } else if (type === 'bool') {
      v = v === true || v === 'true' || v === 'on';
    } else {
      v = String(v ?? '').trim();
      if (field !== 'photo') v = v.slice(0, 2000);
    }
    if (required && v === '') throw new Error(`${field} is required`);
    out[field] = v;
  }
  return out;
}

// Writes apply locally right away (and show up on screen via the listeners);
// Firestore sends them to the server in the background, even after being offline.
function background(promise) {
  promise.catch((e) => {
    console.error(e);
    toast(e.code === 'permission-denied' ? 'Not allowed — this account has no access.' : 'Could not save: ' + e.message);
  });
}

function save(col, id, data, msg) {
  const now = new Date().toISOString();
  let result;
  if (id) {
    result = { id, ...clean(col, data, true), updatedBy: S.me, updatedAt: now };
    const { id: _, ...fields } = result;
    background(updateDoc(doc(fdb, col, id), fields));
  } else {
    const ref = doc(collection(fdb, col));
    const fields = { ...clean(col, data, false), createdBy: S.me, createdAt: now, updatedAt: now };
    background(setDoc(ref, fields));
    result = { id: ref.id, ...fields };
  }
  if (msg) toast(msg);
  return result;
}

function remove(col, id, msg) {
  if (col === 'cats') {
    // Deleting a cat also deletes its weights, meals and dates.
    const batch = writeBatch(fdb);
    batch.delete(doc(fdb, 'cats', id));
    for (const c of CAT_CHILDREN) for (const x of S.db[c].filter((x) => x.catId === id)) batch.delete(doc(fdb, c, x.id));
    background(batch.commit());
  } else {
    background(deleteDoc(doc(fdb, col, id)));
  }
  if (msg) toast(msg);
}

function saveSettings(values, msg) {
  background(setDoc(doc(fdb, 'settings', 'app'), values, { merge: true }));
  if (msg) toast(msg);
}

// Live listeners: every change made on either phone streams in here.
let unsubscribers = [];
function startSync() {
  stopSync();
  S.db = { settings: { currency: '$' } };
  // Show the app once every collection has arrived at least once; after that, re-render on each change.
  const waiting = new Set([...COLLECTIONS, 'settings']);
  const ready = (name) => {
    if (!waiting.size) return scheduleRender();
    waiting.delete(name);
    if (!waiting.size) { render(); tidyCatProfiles(); tidyCategories(); processCapture(); }
  };
  const onError = (e) => {
    console.error(e);
    if (e.code === 'permission-denied') {
      if (!unsubscribers.length) return; // already handled
      stopSync();
      signOut(auth);
      renderLogin('This account is not allowed to use this app.');
    } else toast('Sync problem: ' + e.message);
  };
  for (const c of COLLECTIONS) {
    S.db[c] = [];
    unsubscribers.push(onSnapshot(collection(fdb, c), (snap) => {
      S.db[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      ready(c);
    }, onError));
  }
  unsubscribers.push(onSnapshot(doc(fdb, 'settings', 'app'), (snap) => {
    S.db.settings = { currency: '$', ...(snap.data() || {}) };
    const known = S.db.settings.people || [];
    if (!snap.metadata?.fromCache && S.me && !known.includes(S.me)) saveSettings({ people: [...known, S.me] });
    ready('settings');
  }, onError));
}
function stopSync() { unsubscribers.forEach((u) => u()); unsubscribers = []; }

// Keep "5m ago" labels fresh.
setInterval(() => { if (S.db && !document.hidden && !$('#modal').open) scheduleRender(); }, 60000);

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// ============================================================
// Modal form builder
// ============================================================
// fields: [{ name, label, type: text|number|date|time|month|textarea|select|segment|photo, options, required, value, step, placeholder }]
function openForm({ title, fields, submitLabel = 'Save', onSubmit, onDelete, deleteLabel = 'Delete', confirmDelete = true, meta = '', footer = '' }) {
  const modal = $('#modal');
  const fieldHtml = (f) => {
    const v = f.value ?? '';
    const req = f.required ? 'required' : '';
    const id = 'f_' + f.name;
    if (f.type === 'segment') {
      return `${f.showLabel ? `<div class="field-label">${esc(f.label)}</div>` : ''}<div class="seg${f.wrap ? ' wrap' : ''}" data-seg="${f.name}" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map((o) =>
        `<label><input type="radio" name="${f.name}" value="${esc(o.value)}" ${o.value === v ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}</div>`;
    }
    if (f.type === 'photo') {
      return `<div class="photo-field"><span id="photoPreview">${f.preview || ''}</span>
        <div class="row wrap"><label class="btn">Choose photo<input type="file" accept="image/*" id="photoInput" hidden></label>
        <button type="button" class="btn ghost" id="photoClear">Remove</button></div>
        <input type="hidden" name="${f.name}" value="${esc(v)}"></div>`;
    }
    let input;
    if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    else if (f.type === 'select') {
      input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map((o) => {
        const ov = typeof o === 'string' ? o : o.value, ol = typeof o === 'string' ? (o || '—') : o.label;
        return `<option value="${esc(ov)}" ${ov === v ? 'selected' : ''}>${esc(ol)}</option>`;
      }).join('')}</select>`;
    } else {
      const list = f.suggestions ? `list="${id}_list"` : '';
      input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${req} ${list}
        ${f.step ? `step="${f.step}" inputmode="decimal"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''}
        placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
      if (f.suggestions) input += `<datalist id="${id}_list">${f.suggestions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
    }
    // Optional dates get a Clear button: iPhone date pickers have no way to empty a date once it's set.
    if (f.clearable) {
      return `<div class="field"><label for="${id}"><span>${esc(f.label)}</span></label>
        <div class="clear-wrap">${input}<button type="button" class="btn clear-btn" data-clear="${id}" aria-label="Clear ${esc(f.label)}" ${v ? '' : 'hidden'}>Clear</button></div></div>`;
    }
    return `<label class="field" for="${id}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${input}</label>`;
  };

  modal.innerHTML = `<form method="dialog" novalidate>
    <h3 tabindex="-1" autofocus>${esc(title)}</h3>
    ${meta}
    ${fields.map(fieldHtml).join('')}
    ${footer}
    <p class="form-error" id="formError"></p>
    <div class="modal-actions">
      ${onDelete ? `<button type="button" class="btn danger" id="formDelete">${esc(deleteLabel)}</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" id="formCancel">Cancel</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div></form>`;

  const form = $('form', modal);
  const err = $('#formError', modal);
  $('#formCancel', modal).onclick = () => modal.close();

  modal.querySelectorAll('[data-clear]').forEach((b) => {
    const inp = $(`#${b.dataset.clear}`, modal);
    const sync = () => { b.hidden = !inp.value; };
    inp.addEventListener('input', sync);
    inp.addEventListener('change', sync);
    b.addEventListener('click', () => { inp.value = ''; sync(); inp.dispatchEvent(new Event('change', { bubbles: true })); });
  });

  const photoInput = $('#photoInput', modal);
  if (photoInput) {
    const hidden = form.querySelector('input[type=hidden]');
    photoInput.onchange = async () => {
      const file = photoInput.files[0];
      if (!file) return;
      try {
        hidden.value = await resizeImage(file, 320);
        $('#photoPreview', modal).innerHTML = `<img class="avatar lg" src="${hidden.value}" alt="">`;
      } catch { err.textContent = 'Could not read that image.'; }
    };
    $('#photoClear', modal).onclick = () => { hidden.value = ''; $('#photoPreview', modal).innerHTML = ''; };
  }

  if (onDelete) {
    $('#formDelete', modal).onclick = async () => {
      if (confirmDelete && !confirm(`${deleteLabel}? This can't be undone.`)) return;
      try { await onDelete(); modal.close(); } catch (e) { err.textContent = e.message; }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    for (const f of fields) {
      const el = form.elements[f.name];
      if (f.required && !String(el?.value ?? '').trim()) {
        err.textContent = `${f.label} is required.`;
        el?.focus?.();
        return;
      }
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try { await onSubmit(values); modal.close(); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  };

  modal.showModal();
  const first = form.querySelector('input:not([type=hidden]):not([type=radio]):not([type=file]), textarea, select');
  if (first && matchMedia('(pointer: fine)').matches) first.focus();
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ============================================================
// Login
// ============================================================
const AUTH_ERRORS = {
  'auth/invalid-credential': 'Wrong username or password.',
  'auth/invalid-login-credentials': 'Wrong username or password.',
  'auth/wrong-password': 'Wrong username or password.',
  'auth/user-not-found': 'Wrong username or password.',
  'auth/invalid-email': 'That username isn\'t valid.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
};

function renderLogin(message = '') {
  $('#modal').open && $('#modal').close();
  $('#app').innerHTML = `<div class="login">
    <img src="./icon.svg" alt="">
    <h1>Our Home</h1>
    <p class="muted">Cats, money and groceries — shared.</p>
    <form id="loginForm">
      <label class="field"><span>Username</span><input name="username" required autocomplete="username"
        autocapitalize="none" spellcheck="false" value="${esc(store.get('lastUser', ''))}"></label>
      <label class="field"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
      <p class="form-error" id="loginError">${esc(message)}</p>
      <button class="btn primary" type="submit">Sign in</button>
    </form>${versionTag}</div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const { username, password } = Object.fromEntries(new FormData(e.target).entries());
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, toEmail(username), password);
      store.set('lastUser', username.trim());
      // onAuthStateChanged takes it from here.
    } catch (ex) {
      $('#loginError').textContent = AUTH_ERRORS[ex.code] || ex.message;
      btn.disabled = false;
    }
  };
}

// ============================================================
// Shell
// ============================================================
const TABS = [
  { id: 'home', label: 'Home', ico: '🏠' },
  { id: 'cats', label: 'Cats', ico: '🐱' },
  { id: 'money', label: 'Money', ico: '💰' },
  { id: 'grocery', label: 'Grocery', ico: '🛒' },
];

// ---------- Navigation: slide-out panel on the left, opened by the ☰ button at the bottom centre ----------
function navHtml() {
  const current = TABS.find((t) => t.id === S.tab) || TABS[0];
  const expiring = expiringSoon().length;
  return `
    <button class="nav-fab" data-action="nav" aria-controls="drawer" aria-expanded="${S.navOpen ? 'true' : 'false'}" aria-label="Open navigation · now on ${current.label}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
      <span>${current.label}</span>${expiring ? '<i class="nav-dot" aria-hidden="true"></i>' : ''}
    </button>
    <div class="scrim ${S.navOpen ? 'open' : ''}" data-action="navClose" aria-hidden="true"></div>
    <aside id="drawer" class="drawer ${S.navOpen ? 'open' : ''}" aria-label="Navigation" ${S.navOpen ? '' : 'inert'}>
      <div class="drawer-head"><img src="./icon.svg" alt=""><div><strong>Our Home</strong><span>${esc(S.me)}${roleOf(S.me) ? ` · ${esc(roleOf(S.me))}` : ''}</span></div></div>
      <nav aria-label="Main">${TABS.map((t) => `<button class="drawer-item" data-tab="${t.id}" ${S.tab === t.id ? 'aria-current="page"' : ''}>
        <span class="ico" aria-hidden="true">${t.ico}</span><span class="grow">${t.label}</span>
        ${t.id === 'grocery' && expiring ? `<span class="tab-badge" aria-label="${expiring} expiring soon">${expiring}</span>` : ''}</button>`).join('')}</nav>
      <p class="drawer-foot">V${APP_VERSION}</p>
    </aside>`;
}

function setNav(open) {
  S.navOpen = open;
  $('.drawer')?.classList.toggle('open', open);
  $('.scrim')?.classList.toggle('open', open);
  $('.drawer')?.toggleAttribute('inert', !open);
  $('.nav-fab')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.classList.toggle('nav-open', open);
  if (open) ($('.drawer [aria-current=page]') || $('.drawer-item'))?.focus();
  else $('.nav-fab')?.focus({ preventScroll: true });
}
function render() {
  if (!S.db) return;
  const scroll = window.scrollY;
  const active = document.activeElement?.closest('#groceryAdd') ? document.activeElement.name : null;
  const draft = $('#groceryAdd') ? Object.fromEntries(new FormData($('#groceryAdd')).entries()) : null;
  const body = { home: renderHome, cats: renderCats, money: renderMoney, grocery: renderGrocery }[S.tab] || renderHome;
  $('#app').innerHTML = `
    <header class="topbar">
      <h1><img src="./icon.svg" alt=""><span class="greeting-wrap"><span class="greeting">${greeting()}, ${esc(S.me)}</span>
        <span class="today">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span></span></h1>
      <div class="menu-wrap">
        <button class="btn icon ghost" data-action="menu" title="Settings" aria-label="Settings" aria-haspopup="menu" aria-expanded="${S.menuOpen ? 'true' : 'false'}">⚙️</button>
        ${S.menuOpen ? menuHtml() : ''}
      </div>
    </header>
    <main>${body()}${versionTag}</main>
    ${navHtml()}`;
  if (draft && $('#groceryAdd')) {
    for (const [k, v] of Object.entries(draft)) $('#groceryAdd').elements[k].value = v;
    if (active) $('#groceryAdd').elements[active].focus();
  }
  window.scrollTo(0, scroll);
}

document.addEventListener('click', (e) => {
  if (S.menuOpen && !e.target.closest('.menu, [data-action=menu]')) { S.menuOpen = false; render(); }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    S.tab = tab.dataset.tab;
    store.set('tab', S.tab);
    S.navOpen = false;
    document.body.classList.remove('nav-open');
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  e.preventDefault();
  Promise.resolve(ACTIONS[el.dataset.action](el.dataset.id, el)).catch((ex) => toast(ex.message));
});

// No double-tap zoom. CSS touch-action handles most browsers, but iPhones can still zoom when you
// double-tap text or empty space, so swallow a second quick tap there. Taps on buttons, ticks and
// fields always go through, so tapping two things quickly still works. Pinch-to-zoom is untouched.
const TAPPABLE = 'button, a, input, select, textarea, label, summary, [data-action], [data-tab], [role=button], [contenteditable]';
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  const quick = now - lastTouchEnd < 350;
  lastTouchEnd = now;
  if (quick && e.touches.length === 0 && e.changedTouches.length === 1 && !e.target.closest?.(TAPPABLE)) e.preventDefault();
}, { passive: false });
document.addEventListener('dblclick', (e) => { if (!e.target.closest?.('input, textarea, [contenteditable]')) e.preventDefault(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.navOpen) { setNav(false); return; }
  if (e.key === 'Escape' && S.menuOpen) { S.menuOpen = false; render(); $('[data-action=menu]')?.focus(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-action]')) { e.preventDefault(); e.target.click(); }
});

const ACTIONS = {};
ACTIONS.nav = () => setNav(!S.navOpen);
ACTIONS.navClose = () => setNav(false);

// ---------- Household roles ----------
// Each person sets their own role (the app only lets you change yours). Cats are always "Cat".
const ROLES = ['Wife', 'Husband', 'Partner', 'Other'];
const roleOf = (p) => S.db?.settings?.roles?.[p] || '';
const roleBadge = (p) => (roleOf(p) ? `<span class="badge ok">${esc(roleOf(p))}</span>` : '');

function householdHtml() {
  const members = people();
  const cats = S.db.cats.slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return `<section class="household">
    <h4>👨‍👩‍🐈 Household</h4>
    <ul class="list">
      ${members.map((p) => `<li>${personDot(p)}
        <div class="grow"><div class="title">${esc(p)}${p === S.me ? ' <span class="muted">(you)</span>' : ''}</div>
        ${p !== S.me ? `<div class="meta">Only ${esc(p)} can change this</div>` : roleOf(p) ? '' : '<div class="meta">Set your role below</div>'}</div>
        ${roleOf(p) ? roleBadge(p) : '<span class="badge">No role yet</span>'}</li>`).join('')}
      ${cats.map((c) => `<li class="clickable" data-action="openCat" data-id="${c.id}">${avatar(c)}
        <div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="meta">${esc([c.sex, age(c.birthday)].filter(Boolean).join(' · ') || 'Tap to open')}</div></div>
        <span class="badge">🐱 Cat</span></li>`).join('')}
    </ul>
    ${members.length < 2 ? '<p class="small muted">Your partner will appear here after they sign in once.</p>' : ''}
  </section>`;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

// ---------- Settings menu (⚙️) ----------
const MENU_ICONS = {
  household: '<path d="M3 11l9-7 9 7"></path><path d="M5 10v10h14V10"></path><path d="M10 20v-5h4v5"></path>',
  currency: '<circle cx="12" cy="12" r="8.5"></circle><path d="M14.5 9.2c-.5-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.4-2.5-1.2M12 6.5v1.5M12 16v1.5"></path>',
  activity: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
  pockets: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M4 10h16"></path><path d="M15 14.5h2"></path>',
  period: '<rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M4 10h16M9 3v4M15 3v4"></path><path d="M8.5 14.5h3"></path>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"></path><path d="M4 4v4h4"></path><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"></path><path d="M20 20v-4h-4"></path>',
  auto: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"></rect><path d="M10.5 6h3"></path><path d="M12 10v6M9 13l3 3 3-3"></path>',
  import: '<path d="M12 4v11"></path><path d="M7.5 10.5 12 15l4.5-4.5"></path><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"></path>',
  signout: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"></path><path d="M10 16l-4-4 4-4"></path><path d="M6 12h10"></path>',
};
const menuIcon = (k) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MENU_ICONS[k]}</svg>`;

// Refresh app: checked each time the menu opens (at most once a minute).
S.update = { state: 'idle', latest: null, at: 0 };
async function checkForUpdate() {
  if (S.update.state === 'checking' || Date.now() - S.update.at < 60000) return;
  S.update = { state: 'checking', latest: null, at: Date.now() };
  try {
    const latest = await latestVersion();
    S.update = { state: latest && latest !== APP_VERSION ? 'newer' : 'latest', latest, at: Date.now() };
  } catch {
    S.update = { state: 'error', latest: null, at: 0 };
  }
  if (S.menuOpen) render();
}

function menuHtml() {
  const u = S.update;
  const refresh = {
    checking: { label: 'Refresh app', hint: 'Checking…', disabled: true },
    latest: { label: 'Refresh app', hint: `V${APP_VERSION} · up to date`, disabled: true },
    newer: { label: `Update to V${u.latest}`, hint: `You have V${APP_VERSION}`, disabled: false, fresh: true },
    error: { label: 'Refresh app', hint: "Couldn't check for updates", disabled: false },
    idle: { label: 'Refresh app', hint: 'Checking…', disabled: true },
  }[u.state];
  const item = (action, icon, label, hint = '', extra = '') => `<button role="menuitem" class="menu-item ${extra}" data-action="${action}">
      ${menuIcon(icon)}<span class="grow"><span class="menu-label">${label}</span>${hint ? `<span class="menu-hint">${hint}</span>` : ''}</span></button>`;
  return `<div class="menu" role="menu" aria-label="Settings">
    ${item('openHousehold', 'household', 'Household', esc(people().map((p) => roleOf(p) ? `${p} (${roleOf(p)})` : p).join(' · ')))}
    ${item('openCurrency', 'currency', 'Currency', esc(S.db.settings.currency))}
    ${item('openPockets', 'pockets', 'Pockets', esc(`Yours: ${pocketsOf(S.me, false).join(', ')}`))}
    ${item('openPeriod', 'period', 'Budget period', esc(periodStartDay(S.me) > 1 ? `Yours starts on the ${ordinal(periodStartDay(S.me))}` : 'Yours: calendar month'))}
    ${item('activity', 'activity', 'Recent activity')}
    <button role="menuitem" class="menu-item ${refresh.fresh ? 'fresh' : ''}" data-action="forceRefresh" ${refresh.disabled ? 'disabled aria-disabled="true"' : ''}>
      ${menuIcon('refresh')}<span class="grow"><span class="menu-label">${refresh.label}</span><span class="menu-hint">${refresh.hint}</span></span></button>
    ${item('openAutoAdd', 'auto', 'Auto-add (Apple Pay)', 'Add spending when you tap your card')}
    ${item('openImport', 'import', 'Import records')}
    <hr>
    ${item('signOut', 'signout', 'Sign out', '', 'danger')}
  </div>`;
}

ACTIONS.menu = () => {
  S.menuOpen = !S.menuOpen;
  render();
  if (S.menuOpen) {
    checkForUpdate();
    $('.menu .menu-item:not([disabled])')?.focus();
  }
};

// Every menu item closes the menu first.
const fromMenu = (fn) => (...args) => {
  if (S.menuOpen) { S.menuOpen = false; render(); }
  return fn(...args);
};

ACTIONS.openHousehold = fromMenu(() => openForm({
  title: 'Household',
  meta: householdHtml(),
  fields: [
    { name: 'role', label: `Your role (${S.me})`, type: 'select', value: roleOf(S.me),
      options: [{ value: '', label: 'Choose your role…' }, ...ROLES.map((r) => ({ value: r, label: r }))] },
  ],
  // Only your own entry in "roles" is changed; your partner's stays as they set it.
  onSubmit: (v) => saveSettings({ roles: { ...(S.db.settings.roles || {}), [S.me]: v.role || '' } }, 'Role saved'),
}));

ACTIONS.openCurrency = fromMenu(() => openForm({
  title: 'Currency',
  fields: [{ name: 'currency', label: 'Currency symbol', value: S.db.settings.currency, required: true, placeholder: 'e.g. RM, $, £, €' }],
  onSubmit: (v) => saveSettings({ currency: v.currency.trim().slice(0, 6) || '$' }, 'Currency saved'),
}));

ACTIONS.openPeriod = fromMenu(() => {
  const mine = periodStartDay(S.me);
  const others = people().filter((p) => p !== S.me);
  const preview = (d) => `Your current period: <strong>${fmtRange(periodRange(d, currentPeriodKey(d)))}</strong>`;
  openForm({
    title: 'Budget period',
    meta: `<p class="small muted" style="margin:-6px 0 14px">Pick the day your budget month starts, e.g. the day your salary comes in. Each of you sets your own; Money and Home use it.</p>
      ${others.map((p) => `<p class="small" style="margin:0 0 12px">${personDot(p)} <strong>${esc(p)}</strong>: ${periodStartDay(p) > 1 ? `starts on the ${ordinal(periodStartDay(p))}` : 'calendar month'} <span class="muted">· ${fmtRange(periodOf(p, 0))} · only ${esc(p)} can change this</span></p>`).join('')}`,
    fields: [{
      name: 'periodDay', label: `Your budget month starts on (${S.me})`, type: 'select', value: String(mine),
      options: Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: i === 0 ? '1st (calendar month)' : `${ordinal(i + 1)} of the month` })),
    }],
    footer: `<p class="small" id="periodPreview" style="margin:-4px 0 8px">${preview(mine)}</p>`,
    // Only your own entry changes; your partner's stays as they set it.
    onSubmit: (v) => saveSettings({ periodStart: { ...(S.db.settings.periodStart || {}), [S.me]: Number(v.periodDay) || 1 } }, 'Budget period saved'),
  });
  $('#f_periodDay').addEventListener('change', (e) => { $('#periodPreview').innerHTML = preview(Number(e.target.value)); });
});

ACTIONS.openPockets = fromMenu(() => {
  const extras = pocketsOf(S.me, false).slice(1);
  const slots = extras.length + 2;
  openForm({
    title: 'Your pockets',
    meta: `<p class="small muted" style="margin:-6px 0 14px"><strong>Main</strong> is always there and is the default. Add pockets like Meal, Selfcare or Clothes. Renaming keeps a pocket's entries; clearing a name removes the pocket and moves its entries to Main.</p>`,
    fields: Array.from({ length: slots }, (_, i) => ({
      name: `pocket_${i}`, label: i < extras.length ? `Pocket ${i + 2}` : 'New pocket', value: extras[i] || '',
      placeholder: ['e.g. Meal', 'e.g. Selfcare', 'e.g. Clothes'][Math.max(0, i - extras.length)] || 'e.g. Savings',
    })),
    onSubmit: (v) => {
      const next = [];
      for (let i = 0; i < slots; i++) {
        const name = (v[`pocket_${i}`] || '').trim().slice(0, 30);
        if (name && name.toLowerCase() !== MAIN_POCKET.toLowerCase() && !next.some((x) => x.toLowerCase() === name.toLowerCase())) next.push(name);
      }
      // Renamed pockets keep their entries; removed ones go back to Main.
      const moves = {};
      extras.forEach((old, i) => {
        const now = (v[`pocket_${i}`] || '').trim().slice(0, 30);
        if (!now || now.toLowerCase() === MAIN_POCKET.toLowerCase()) moves[old] = MAIN_POCKET;
        else if (now !== old) moves[old] = next.find((x) => x.toLowerCase() === now.toLowerCase()) || MAIN_POCKET;
      });
      const batch = writeBatch(fdb);
      let n = 0;
      for (const t of S.db.transactions) {
        if (personOf(t) === S.me && t.pocket && moves[t.pocket]) { batch.update(doc(fdb, 'transactions', t.id), { pocket: moves[t.pocket] }); n++; }
      }
      if (n) background(batch.commit());
      if (S.pocket && moves[S.pocket]) S.pocket = null;
      saveSettings({ pockets: { ...(S.db.settings.pockets || {}), [S.me]: next } }, 'Pockets saved');
    },
  });
});

ACTIONS.signOut = fromMenu(() => signOut(auth));

// ============================================================
// Import (Settings → Import cat records)
// File format: { "format": "our-home-import", "cats": [ { name, sex, birthday, breed, color, microchip, notes,
//   weights: [{ date, kg, notes }], events: [{ type, date, nextDue, notes }], feedings: [{ time, food, amount, notes }] } ] }
// Cats are matched to existing ones by name; records already in the app are skipped, so importing twice is safe.
// ============================================================
function planImport(data) {
  if (!data || !Array.isArray(data.cats)) throw new Error("This doesn't look like an Our Home import file.");
  return data.cats.map((c) => {
    const profile = clean('cats', c, false);
    const existing = S.db.cats.find((x) => x.name.trim().toLowerCase() === profile.name.toLowerCase());
    const mine = (col) => (existing ? S.db[col].filter((x) => x.catId === existing.id) : []);
    const child = (col, list, same) => {
      const rows = (list || []).map((x) => { const { catId, ...rest } = clean(col, { ...x, catId: '-' }, false); return rest; });
      const fresh = rows.filter((r) => !mine(col).some((x) => same(x, r)));
      return { fresh, skipped: rows.length - fresh.length };
    };
    const weights = child('weights', c.weights, (a, b) => a.date === b.date && Number(a.kg) === b.kg);
    const events = child('events', c.events, (a, b) => a.type === b.type && a.date === b.date);
    const feedings = child('feedings', c.feedings, (a, b) => a.time === b.time);
    // For a cat already in the app, only fill in profile fields that are still empty.
    const fill = existing ? Object.fromEntries(Object.entries(profile).filter(([k, v]) => k !== 'name' && v && !existing[k])) : {};
    return {
      name: profile.name, profile, existing, fill,
      weights: weights.fresh, events: events.fresh, feedings: feedings.fresh,
      skipped: weights.skipped + events.skipped + feedings.skipped,
      count: (existing ? (Object.keys(fill).length ? 1 : 0) : 1) + weights.fresh.length + events.fresh.length + feedings.fresh.length,
    };
  });
}

function runImport(plan) {
  const batch = writeBatch(fdb);
  const now = new Date().toISOString();
  const stamp = { createdBy: S.me, createdAt: now, updatedAt: now };
  for (const c of plan) {
    let catId = c.existing?.id;
    if (!catId) {
      const ref = doc(collection(fdb, 'cats'));
      catId = ref.id;
      batch.set(ref, { ...c.profile, ...stamp });
    } else if (Object.keys(c.fill).length) {
      batch.update(doc(fdb, 'cats', catId), { ...c.fill, updatedBy: S.me, updatedAt: now });
    }
    for (const [col, rows] of [['weights', c.weights], ['events', c.events], ['feedings', c.feedings]]) {
      for (const r of rows) batch.set(doc(collection(fdb, col)), { ...r, catId, ...stamp });
    }
  }
  background(batch.commit());
}

ACTIONS.openImport = fromMenu(() => {
  const modal = $('#modal');
  if (modal.open) modal.close();
  modal.innerHTML = `<form id="importForm">
    <h3>📥 Import records</h3>
    <p class="small muted" style="margin-top:-8px">Choose the import file, or paste its contents. You'll see what will be added before anything is saved.</p>
    <p><label class="btn">Choose file<input type="file" id="importFile" accept=".json,application/json,text/plain" hidden></label></p>
    <label class="field"><span>…or paste it here</span><textarea id="importText" rows="4" spellcheck="false"></textarea></label>
    <div id="importPreview"></div>
    <p class="form-error" id="importError"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button type="button" class="btn" id="importCancel">Cancel</button>
      <button type="submit" class="btn primary" id="importGo" disabled>Import</button></div>
  </form>`;
  let plan = null;
  const err = $('#importError', modal), go = $('#importGo', modal), preview = $('#importPreview', modal);
  const update = () => {
    plan = null; go.disabled = true; err.textContent = ''; preview.innerHTML = '';
    const text = $('#importText', modal).value.trim();
    if (!text) return;
    try {
      plan = planImport(JSON.parse(text));
    } catch (e) {
      err.textContent = e instanceof SyntaxError ? "Couldn't read that. Make sure you pasted the whole file." : e.message;
      return;
    }
    const total = plan.reduce((n, c) => n + c.count, 0);
    const parts = (c) => [
      c.weights.length && `${c.weights.length} weight${c.weights.length === 1 ? '' : 's'}`,
      c.events.length && `${c.events.length} date${c.events.length === 1 ? '' : 's'}`,
      c.feedings.length && `${c.feedings.length} meal${c.feedings.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ') || 'nothing new';
    preview.innerHTML = `<ul class="list">${plan.map((c) => `<li><div class="grow">
      <div class="title">${esc(c.name)} <span class="badge ${c.existing ? '' : 'ok'}">${c.existing ? 'already in app' : 'new cat'}</span></div>
      <div class="meta">${parts(c)}${c.skipped ? ` · ${c.skipped} already in the app (skipped)` : ''}</div></div></li>`).join('')}</ul>`;
    go.disabled = total === 0;
    go.textContent = total ? `Import ${total} record${total === 1 ? '' : 's'}` : 'Nothing new to import';
  };
  $('#importText', modal).addEventListener('input', update);
  $('#importFile', modal).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#importText', modal).value = await file.text();
    update();
  });
  $('#importCancel', modal).onclick = () => modal.close();
  $('#importForm', modal).onsubmit = (e) => {
    e.preventDefault();
    if (!plan) return;
    runImport(plan);
    S.catId = 'all';
    store.set('catId', 'all');
    S.tab = 'cats';
    store.set('tab', 'cats');
    modal.close();
    render();
    toast('Imported. Both phones will see it shortly.');
  };
  modal.showModal();
});

// ============================================================
// Home: the overview of everything
// ============================================================
function renderHome() {
  const catById = Object.fromEntries(S.db.cats.map((c) => [c.id, c]));
  const due = dueList().filter((x) => catById[x.e.catId]).slice(0, 5);
  const toBuy = S.db.groceries.filter((g) => !g.bought)
    .sort((a, b) => b.addedDate.localeCompare(a.addedDate) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const expiring = expiringSoon();
  const more = (tab) => `<button class="btn ghost small" data-tab="${tab}">See all ›</button>`;

  const catsCard = `<div class="card">
    <div class="section-head"><h2>🐾 Cats · next up</h2>${more('cats')}</div>
    ${!S.db.cats.length ? '<p class="empty">No cats yet.</p>'
      : due.length ? due.map(({ e, due: d, planned, label }) => `<div class="reminder clickable" role="button" tabindex="0" data-action="openCat" data-id="${e.catId}">
          ${avatar(catById[e.catId])}
          <div class="grow"><div><strong>${esc(catById[e.catId].name)}</strong> · ${EVENT_ICONS[e.type] || '📌'} ${esc(label || e.type)}</div>
          <div class="meta muted small">${planned ? 'Planned' : `Last ${fmtShort(e.date)}`}${e.notes ? ' · ' + esc(shorten(e.notes, 60)) : ''}</div></div>
          ${dueBadge(d)}</div>`).join('')
      : '<p class="empty">Nothing scheduled. Add a "next due" date to a vaccine, deworm or vet visit.</p>'}
  </div>`;

  const moneyCard = `<div class="card">
    <div class="section-head"><h2>💰 This budget period</h2>${more('money')}</div>
    ${people().map((p) => personBalance(p, 0)).join('')}
  </div>`;

  const expiringCard = expiring.length ? `<div class="card alert">
    <div class="section-head"><h2>⚠️ Expiring soon<small>${expiring.length}</small></h2>${more('grocery')}</div>
    <ul class="list">${expiring.map((g) => `<li class="clickable" data-action="editGrocery" data-id="${g.id}">
      <div class="grow"><div class="title">${esc(g.name)}${g.quantity ? ` <span class="muted">· ${esc(g.quantity)}</span>` : ''}</div></div>
      ${expiryBadge(g.expiry)}</li>`).join('')}</ul>
  </div>` : '';

  const shown = toBuy.slice(0, 8);
  const groceryCard = `<div class="card">
    <div class="section-head"><h2>🛒 To buy<small>${toBuy.length}</small></h2>${more('grocery')}</div>
    ${toBuy.length ? `<ul class="list">${shown.map((g) => `<li>
        <button class="check" data-action="toggleGrocery" data-id="${g.id}" aria-label="Mark ${esc(g.name)} as bought">✓</button>
        <span class="g-emoji sm" aria-hidden="true">${groceryKind(g.name).emoji}</span>
        <div class="grow"><div class="title">${esc(g.name)}${g.quantity ? ` <span class="muted">· ${esc(g.quantity)}</span>` : ''}</div>
        <div class="meta">Out since ${fmtShort(g.addedDate)}</div></div></li>`).join('')}</ul>
      ${toBuy.length > shown.length ? `<p class="small muted" style="margin:8px 0 0">and ${toBuy.length - shown.length} more…</p>` : ''}`
      : '<p class="empty">Nothing to buy. 🎉</p>'}
  </div>`;

  return `
    ${expiringCard}${catsCard}${moneyCard}${groceryCard}`;
}

ACTIONS.openCat = (id) => {
  if ($('#modal').open) $('#modal').close();
  S.tab = 'cats'; store.set('tab', 'cats');
  S.catId = id; store.set('catId', id);
  render();
  window.scrollTo(0, 0);
};

// ============================================================
// Recent activity (both of you, all modules)
// ============================================================
const MODULE_ICONS = { cats: '🐱', weights: '⚖️', feedings: '🍽️', events: '📅', transactions: '💰', groceries: '🛒' };

function describe(col, x) {
  const catName = (id) => S.db.cats.find((c) => c.id === id)?.name || 'a cat';
  switch (col) {
    case 'cats': return `${x.name}'s profile`;
    case 'weights': return `${catName(x.catId)}'s weight · ${fmtKg(x.kg)}`;
    case 'feedings': return `${catName(x.catId)}'s meal at ${x.time}${x.food ? ` (${x.food})` : ''}`;
    case 'events': return `${catName(x.catId)} · ${x.type} on ${fmtShort(x.date)}`;
    case 'transactions': return `${x.type === 'income' ? 'Income' : 'Spending'} · ${x.description || x.category || ''} ${money(x.amount)}${personOf(x) ? ` (${personOf(x) === S.me ? 'yours' : `${personOf(x)}'s`})` : ''}`;
    case 'groceries': return x.name;
    default: return '';
  }
}

function activityItems(limit = 40) {
  const items = [];
  for (const col of Object.keys(MODULE_ICONS)) {
    for (const x of S.db[col] || []) {
      if (x.createdBy) items.push({ col, at: x.createdAt, who: x.createdBy, verb: 'added', what: describe(col, x) });
      if (wasEdited(x)) {
        const verb = col === 'groceries' ? (x.bought ? 'marked as bought' : 'updated') : 'updated';
        items.push({ col, at: x.updatedAt, who: x.updatedBy, verb, what: describe(col, x) });
      }
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

ACTIONS.activity = fromMenu(() => {
  const items = activityItems();
  const modal = $('#modal');
  modal.innerHTML = `<form method="dialog">
    <h3>🕘 Recent activity</h3>
    ${items.length ? `<ul class="list activity">${items.map((a) => `<li>
      ${personDot(a.who)}
      <div class="grow"><div><strong>${esc(a.who)}</strong> ${a.verb} <span aria-hidden="true">${MODULE_ICONS[a.col]}</span> ${esc(a.what)}</div>
      <div class="meta">${ago(a.at)}</div></div></li>`).join('')}</ul>`
      : '<p class="empty">Nothing yet. Changes you both make will show up here.</p>'}
    <div class="modal-actions"><span class="spacer"></span><button class="btn primary" value="close">Close</button></div>
  </form>`;
  modal.showModal();
});

// ============================================================
// Cats
// ============================================================
const EVENT_TYPES = ['Vaccination', 'Deworm + flea', 'Deflea', 'Deworm', 'Vet visit', 'Test / lab result', 'Medication',
  'Health note', 'Weigh-in', 'Neuter', 'Grooming', 'Adopted', 'Birthday', 'Other'];
const EVENT_ICONS = {
  Vaccination: '💉', 'Deworm + flea': '🛡️', Deflea: '🪲', Deworm: '💊', 'Vet visit': '🩺', 'Test / lab result': '🧪',
  Medication: '💊', 'Health note': '📝', 'Weigh-in': '⚖️', Neuter: '🏥', Grooming: '✂️', Adopted: '🏠', Birthday: '🎂',
};
const shorten = (t, n = 70) => (t && t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t || '');

function currentCat() {
  const cats = S.db.cats;
  if (S.catId === 'all') return null;
  let cat = cats.find((c) => c.id === S.catId);
  if (!cat && cats.length) {
    // Nothing (valid) picked yet: show the overview when there's more than one cat.
    if (cats.length > 1) { S.catId = 'all'; return null; }
    cat = cats[0]; S.catId = cat.id;
  }
  return cat;
}

// Each cat gets its own colour, in the order they were added (so lines on the graph never clash).
const catColor = (cat) => {
  const order = (S.db?.cats || []).slice()
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  const i = Math.max(0, order.findIndex((c) => c.id === cat.id));
  return CAT_COLORS[i % CAT_COLORS.length];
};
const weightsOf = (catId) => S.db.weights.filter((w) => w.catId === catId)
  .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));
// Kittens: show grams under 1 kg ("843 g"), kilograms above ("1.05 kg").
const fmtKg = (kg) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${+Number(kg).toFixed(3)} kg`);
const kgDiff = (a, b) => Math.round((a - b) * 1000) / 1000;
const diffBadge = (d) => {
  if (!d) return '';
  const amount = Math.abs(d) < 1 ? `${Math.round(Math.abs(d) * 1000)} g` : `${+Math.abs(d).toFixed(2)} kg`;
  return `<span class="badge">${d > 0 ? '▲ +' : '▼ −'}${amount}</span>`;
};

// Everything due, soonest first:
// - the "next due" date of the latest done event of each (cat, type)
// - planned events (dated in the future)
function dueList() {
  const t = today();
  const latest = new Map();
  for (const e of S.db.events) {
    if (e.date > t) continue;
    const key = e.catId + '|' + e.type, prev = latest.get(key);
    if (!prev || e.date > prev.date) latest.set(key, e);
  }
  const items = [];
  for (const e of latest.values()) {
    if (/vaccin/i.test(e.type)) {
      // Vaccines: next dose, or the yearly booster once fully vaccinated.
      const cat = S.db.cats.find((c) => c.id === e.catId);
      const vac = cat && vaccinationOf(cat);
      if (vac?.next) items.push({ e, due: vac.next, planned: false, label: vac.full ? 'Yearly booster' : e.type });
    } else if (e.nextDue) items.push({ e, due: e.nextDue, planned: false });
  }
  for (const e of S.db.events) if (e.date > t) items.push({ e, due: e.date, planned: true });
  return items.sort((a, b) => a.due.localeCompare(b.due));
}
const upcomingReminders = () => dueList().filter((x) => daysUntil(x.due) <= 30);

// ---------- Health summary (from the profile and Important dates) ----------
const FIV_RESULTS = ['Negative', 'FIV positive', 'FeLV positive', 'FIV & FeLV positive'];
const mentionsFiv = (e) => /FIV\s*\/?\s*FeLV/i.test(`${e.type} ${e.notes || ''}`);
const pastEvents = (catId) => S.db.events.filter((e) => e.catId === catId && e.date <= today())
  .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

// FIV/FeLV: the profile field, or (until it's set) the latest test found in Important dates.
function fivFelvOf(cat) {
  if (cat.fivFelv) return { result: cat.fivFelv, date: cat.fivFelvDate || '' };
  const e = pastEvents(cat.id).find((x) => mentionsFiv(x) && /negative/i.test(x.notes || ''));
  return e ? { result: 'Negative', date: e.date, derived: true } : null;
}

function ordinal(n) { return `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`; }

// Vaccination status: set by hand in the profile, or worked out from Vaccination entries.
// 3 doses = fully vaccinated; after that it's a yearly booster, due a year after the last shot
// (unless a different "next due" date was entered).
const FULL_DOSES = 3;
const addYear = (d) => { const x = parseDate(d); x.setFullYear(x.getFullYear() + 1); return toISO(x); };
function vaccinationOf(cat) {
  const shots = pastEvents(cat.id).filter((e) => /vaccin/i.test(e.type));
  const latest = shots[0];
  // Dose number: "Vaccine 2" / "dose 3" in the notes of the latest shot, or the number of shots, whichever is higher.
  const n = latest ? Math.max(Number((latest.notes || '').match(/\b(?:dose|vaccine)\s*(\d)\b/i)?.[1]) || 0, shots.length) : 0;
  const full = cat.vaccineStatus ? cat.vaccineStatus === 'Fully vaccinated'
    : n >= FULL_DOSES || shots.some((e) => /\b(final|fully|complete[d]?|booster)\b/i.test(e.notes || ''));
  if (!latest && !cat.vaccineStatus) return null;
  const next = latest ? (latest.nextDue || (full ? addYear(latest.date) : '')) : '';
  const status = cat.vaccineStatus || (full ? 'Fully vaccinated' : `${ordinal(n)} dose done`);
  return { status, latest, next, full, nextLabel: full ? 'Yearly booster' : 'Next dose' };
}

// Latest deworm / deflea, counting "Deworm + flea" for both.
function lastTreatment(cat, kind) {
  const re = kind === 'deworm' ? /deworm/i : /flea|deflea/i;
  return pastEvents(cat.id).find((e) => re.test(e.type)) || null;
}

function healthFacts(cat) {
  const fiv = fivFelvOf(cat);
  const vac = vaccinationOf(cat);
  const worm = lastTreatment(cat, 'deworm');
  const flea = lastTreatment(cat, 'deflea');
  const none = '<span class="muted">Not recorded</span>';
  const next = (d, label = 'next') => (!d ? '' : daysUntil(d) <= 14 ? `<div class="meta">${label} ${fmtShort(d)} ${dueBadge(d)}</div>` : `<div class="meta">${label} ${fmtDate(d)}</div>`);
  const rows = [
    ['FIV/FeLV', fiv ? `<span class="badge ${fiv.result === 'Negative' ? 'ok' : 'danger'}">${esc(fiv.result)}</span>
      ${fiv.date ? `<div class="meta">Tested ${fmtDate(fiv.date)}</div>` : ''}` : none],
    ['Vaccination', vac ? `<span class="badge ${vac.full ? 'ok' : 'warn'}">${esc(vac.status)}</span>
      ${vac.latest ? `<div class="meta">Last ${fmtDate(vac.latest.date)}</div>` : ''}${next(vac.next, vac.full ? 'Yearly booster' : 'Next dose')}` : '<span class="badge">Not vaccinated yet</span>'],
    ['Last deworm', worm ? `${fmtDate(worm.date)}${next(worm.nextDue)}` : none],
    ['Last deflea', flea ? `${fmtDate(flea.date)}${next(flea.nextDue)}` : none],
  ];
  return `<h3 class="facts-head">🩺 Health</h3>
    <div class="facts health">${rows.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}</div>`;
}

// ---------- Adopted date ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "Adopted 14 Oct 2026." / "Rescue, adopted 25 Oct 2026." inside notes.
const ADOPTED_IN_NOTES = /\b(Rescue,\s*)?adopted\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\.?[ \t]*/i;

// The profile field, or (until it's set) the "Adopted" entry in Important dates, or the date written in the notes.
function adoptedOf(cat) {
  if (cat.adopted) return cat.adopted;
  const e = S.db.events.filter((x) => x.catId === cat.id && /adopt/i.test(x.type)).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (e) return e.date;
  const m = (cat.notes || '').match(ADOPTED_IN_NOTES);
  const mon = m && MONTHS[m[3].toLowerCase()];
  return mon ? `${m[4]}-${pad(mon)}-${pad(m[2])}` : '';
}

// One-time tidy-up: move FIV/FeLV results and adoption dates out of a cat's notes into their own fields.
let catsTidied = false;
function tidyCatProfiles() {
  if (catsTidied) return;
  catsTidied = true;
  const now = new Date().toISOString();
  const batch = writeBatch(fdb);
  let changes = 0;
  for (const cat of S.db.cats) {
    const update = {};
    let notes = cat.notes || '';
    if (!cat.fivFelv) {
      const found = fivFelvOf(cat);
      if (found) {
        Object.assign(update, { fivFelv: found.result, fivFelvDate: found.date });
        notes = notes.replace(/^[ \t]*FIV\s*\/\s*FeLV[^\n]*(\n|$)/gim, '');
      }
    }
    if (!cat.adopted) {
      const date = adoptedOf(cat);
      if (date) {
        update.adopted = date;
        // Keep "Rescue." if it was part of the sentence.
        notes = notes.replace(ADOPTED_IN_NOTES, (_, rescue) => (rescue ? 'Rescue. ' : ''));
      }
    }
    if (!Object.keys(update).length) continue;
    notes = notes.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
    batch.update(doc(fdb, 'cats', cat.id), { ...update, notes, updatedBy: S.me, updatedAt: now });
    changes++;
  }
  if (changes) background(batch.commit());
}

function renderCats() {
  const cats = S.db.cats;
  const cat = currentCat();
  const chips = `<div class="chips">
    ${cats.length ? `<button class="chip" data-action="pickCat" data-id="all" aria-pressed="${S.catId === 'all'}">
      <span class="avatar all" aria-hidden="true">🐾</span>All cats</button>` : ''}
    ${cats.map((c) => `<button class="chip" data-action="pickCat" data-id="${c.id}" aria-pressed="${c.id === cat?.id}">
      ${avatar(c)}${esc(c.name)}</button>`).join('')}
    <button class="chip add" data-action="addCat">＋ Add cat</button></div>`;

  if (!cats.length) {
    return chips + `<div class="card empty"><p style="font-size:2.5rem;margin:0">🐾</p>
      <p>No cats yet. Add your first cat to start tracking weight, feeding and vet dates.</p>
      <button class="btn primary" data-action="addCat">Add a cat</button></div>`;
  }

  const reminders = upcomingReminders();
  const catById = Object.fromEntries(cats.map((c) => [c.id, c]));
  const remindersHtml = reminders.length ? `<div class="card">
      <div class="section-head"><h2>⏰ Coming up</h2></div>
      ${reminders.filter((r) => catById[r.e.catId]).slice(0, S.showAllReminders ? undefined : 5).map(({ e, due, planned, label }) => `<div class="reminder">${avatar(catById[e.catId])}
        <div class="grow"><div><strong>${esc(catById[e.catId].name)}</strong> · ${esc(label || e.type)}</div>
        <div class="meta muted small">${planned ? 'Planned' : `Last ${fmtShort(e.date)}`}${e.notes ? ' · ' + esc(shorten(e.notes)) : ''}</div></div>
        ${dueBadge(due)}</div>`).join('')}
      ${reminders.length > 5 ? `<button class="btn ghost" data-action="toggleReminders">${S.showAllReminders ? 'Show less' : `Show all ${reminders.length}`}</button>` : ''}
    </div>` : '';

  if (!cat) return chips + remindersHtml + renderCatsOverview();

  const weights = weightsOf(cat.id);
  const latestW = weights[weights.length - 1];
  const feedings = S.db.feedings.filter((f) => f.catId === cat.id).sort((a, b) => a.time.localeCompare(b.time));
  const events = S.db.events.filter((e) => e.catId === cat.id).sort((a, b) => b.date.localeCompare(a.date));

  const facts = [
    ['Age', age(cat.birthday)], ['Birthday', fmtDate(cat.birthday)], ['Adopted', fmtDate(adoptedOf(cat))], ['Sex', cat.sex], ['Breed', cat.breed],
    ['Colour', cat.color], ['Microchip', cat.microchip], ['Weight', latestW ? fmtKg(latestW.kg) : ''],
  ].filter(([, v]) => v);

  const profile = `<div class="card">
    <div class="profile">${avatar(cat, 'lg')}
      <div class="grow"><h2>${esc(cat.name)}</h2>
        <div class="muted small">${esc([cat.breed, age(cat.birthday)].filter(Boolean).join(' · ')) || 'Add details in the profile'}</div></div>
      <button class="btn" data-action="editCat" data-id="${cat.id}">Edit</button></div>
    ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>` : ''}
    ${healthFacts(cat)}
    ${cat.notes ? `<p class="notes">${esc(cat.notes)}</p>` : ''}
    <div class="small" style="margin-top:12px">${byline(cat)}</div>
  </div>`;

  const weightCard = `<div class="card">
    <div class="section-head"><h2>⚖️ Weight</h2><button class="btn primary" data-action="addWeight">＋ Log weight</button></div>
    ${weights.length ? weightChart([{ name: cat.name, color: null, points: weights }]) : ''}
    ${weights.length ? `<ul class="list">${weights.slice().reverse().slice(0, S.showAllWeights ? undefined : 6).map((w) => {
      const i = weights.indexOf(w), prev = weights[i - 1];
      return `<li class="clickable" data-action="editWeight" data-id="${w.id}">
        <div class="grow"><div class="title">${fmtKg(w.kg)}</div><div class="meta">${fmtDate(w.date)}${w.notes ? ' · ' + esc(w.notes) : ''}</div>
        <div class="meta">${byline(w)}</div></div>
        ${prev ? diffBadge(kgDiff(w.kg, prev.kg)) : ''}</li>`;
    }).join('')}</ul>
    ${weights.length > 6 ? `<button class="btn ghost" data-action="toggleWeights">${S.showAllWeights ? 'Show less' : `Show all ${weights.length}`}</button>` : ''}`
    : `<p class="empty">No weigh-ins yet.</p>`}
  </div>`;

  const feedingCard = `<div class="card">
    <div class="section-head"><h2>🍽️ Feeding schedule</h2><button class="btn primary" data-action="addFeeding">＋ Add meal</button></div>
    ${feedings.length ? `<ul class="list">${feedings.map((f) => `<li class="clickable" data-action="editFeeding" data-id="${f.id}">
      <span class="time-pill">${esc(f.time)}</span>
      <div class="grow"><div class="title">${esc(f.food || 'Meal')}${f.amount ? ` <span class="muted">· ${esc(f.amount)}</span>` : ''}</div>
      ${f.notes ? `<div class="meta">${esc(f.notes)}</div>` : ''}<div class="meta">${byline(f)}</div></div></li>`).join('')}</ul>`
    : `<p class="empty">No meals scheduled.</p>`}
  </div>`;

  const eventsCard = `<div class="card">
    <div class="section-head"><h2>📅 Important dates</h2><button class="btn primary" data-action="addEvent">＋ Add</button></div>
    ${events.length ? `<ul class="list">${events.map((e) => `<li class="clickable" data-action="editEvent" data-id="${e.id}">
      <span style="font-size:1.4rem" aria-hidden="true">${EVENT_ICONS[e.type] || '📌'}</span>
      <div class="grow"><div class="title">${esc(e.type)}</div>
      <div class="meta">${e.date > today() ? `Planned for ${fmtDate(e.date)}` : fmtDate(e.date)}${e.nextDue ? ` · next ${fmtDate(e.nextDue)}` : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div>
      <div class="meta">${byline(e)}</div></div>
      ${e.date > today() ? dueBadge(e.date) : e.nextDue ? dueBadge(e.nextDue) : ''}</li>`).join('')}</ul>`
    : `<p class="empty">Record vaccines, deflea and deworm treatments, vet visits and more. Set a "next due" date to get a reminder.</p>`}
  </div>`;

  return chips + profile + eventsCard + weightCard + feedingCard;
}

// series: [{ name, color (null = theme accent with shaded area), points: [{ date, kg }] }]
function weightChart(series) {
  const W = 360, H = 160, P = { l: 30, r: 10, t: 10, b: 20 };
  series = series.map((s) => ({ ...s, points: s.points.slice(-24) })).filter((s) => s.points.length);
  const all = series.flatMap((s) => s.points);
  const xs = all.map((w) => parseDate(w.date).getTime());
  const ys = all.map((w) => w.kg);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const padY = Math.max((maxY - minY) * 0.2, 0.2);
  minY = Math.max(0, minY - padY); maxY += padY;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const x = (d) => P.l + (maxX === minX ? 0.5 : (parseDate(d).getTime() - minX) / (maxX - minX)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - minY) / (maxY - minY)) * (H - P.t - P.b);
  const ticks = [minY, (minY + maxY) / 2, maxY];
  const first = all.reduce((a, b) => (a.date < b.date ? a : b)).date;
  const last = all.reduce((a, b) => (a.date > b.date ? a : b)).date;

  const lines = series.map((s) => {
    const d = s.points.map((w, i) => `${i ? 'L' : 'M'}${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join('');
    const stroke = s.color ? ` style="stroke:${s.color}"` : '';
    const area = !s.color && s.points.length > 1
      ? `<path class="area" d="${d}L${x(s.points[s.points.length - 1].date).toFixed(1)},${H - P.b}L${x(s.points[0].date).toFixed(1)},${H - P.b}Z"/>` : '';
    return `${area}${s.points.length > 1 ? `<path class="line" d="${d}"${stroke}/>` : ''}
      ${s.points.map((w) => `<circle class="dot" cx="${x(w.date)}" cy="${y(w.kg)}" r="3.5"${stroke}>
        <title>${esc(s.name)} · ${fmtDate(w.date)}: ${fmtKg(w.kg)}</title></circle>`).join('')}`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time">
    ${ticks.map((t) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    ${lines}
    ${first === last
      ? `<text x="${W / 2}" y="${H - 5}" text-anchor="middle">${fmtShort(first)}</text>`
      : `<text x="${P.l}" y="${H - 5}">${fmtShort(first)}</text><text x="${W - P.r}" y="${H - 5}" text-anchor="end">${fmtShort(last)}</text>`}
  </svg>`;
}

function renderCatsOverview() {
  const cats = S.db.cats.slice().sort((a, b) => a.name.localeCompare(b.name));
  const series = cats.map((c) => ({ cat: c, name: c.name, color: catColor(c), points: weightsOf(c.id) }));
  const withWeights = series.filter((s) => s.points.length);

  const chartCard = `<div class="card">
    <div class="section-head"><h2>⚖️ Weight · all cats</h2><button class="btn primary" data-action="addWeight">＋ Log weight</button></div>
    ${withWeights.length ? weightChart(withWeights) + `<div class="legend">${withWeights.map((s) => {
      const lastW = s.points[s.points.length - 1];
      return `<button class="legend-item" data-action="pickCat" data-id="${s.cat.id}">
        <i style="background:${s.color}"></i>${esc(s.name)} <strong>${fmtKg(lastW.kg)}</strong></button>`;
    }).join('')}</div>` : '<p class="empty">No weigh-ins yet. Log a weight to see the graph.</p>'}
  </div>`;

  const nextDue = (catId) => dueList().find((x) => x.e.catId === catId);
  const cards = cats.map((c) => {
    const ws = weightsOf(c.id), lastW = ws[ws.length - 1], prevW = ws[ws.length - 2];
    const meals = S.db.feedings.filter((f) => f.catId === c.id).sort((a, b) => a.time.localeCompare(b.time));
    const due = nextDue(c.id);
    // Most recent change to anything about this cat.
    const related = [c, ...ws, ...meals, ...S.db.events.filter((e) => e.catId === c.id)];
    const latest = related.reduce((a, b) => ((b.updatedAt || '') > (a.updatedAt || '') ? b : a), c);
    return `<div class="cat-card" role="button" tabindex="0" data-action="pickCat" data-id="${c.id}" aria-label="Open ${esc(c.name)}">
      <div class="row">${avatar(c)}<div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="meta">${esc([c.sex, age(c.birthday)].filter(Boolean).join(' · ') || c.breed || '')}</div></div>
        <span class="muted" aria-hidden="true">›</span></div>
      <dl>
        <div><dt>Weight</dt><dd>${lastW ? `${fmtKg(lastW.kg)} ${prevW ? diffBadge(kgDiff(lastW.kg, prevW.kg)) : ''}<span class="meta"> · ${fmtShort(lastW.date)}</span>` : '<span class="muted">—</span>'}</dd></div>
        <div><dt>Next up</dt><dd>${due ? `${esc(due.label || due.e.type)} ${dueBadge(due.due)}` : '<span class="muted">Nothing scheduled</span>'}</dd></div>
        <div><dt>Meals</dt><dd>${meals.length ? meals.map((m) => esc(m.time)).join(', ') : '<span class="muted">—</span>'}</dd></div>
      </dl>
      <div class="small">${byline(latest)}</div>
    </div>`;
  }).join('');

  return chartCard + `<div class="cat-grid">${cards}</div>`;
}


ACTIONS.pickCat = (id) => { S.catId = id; store.set('catId', id); render(); };
ACTIONS.toggleWeights = () => { S.showAllWeights = !S.showAllWeights; render(); };
ACTIONS.toggleReminders = () => { S.showAllReminders = !S.showAllReminders; render(); };

function catForm(cat) {
  openForm({
    title: cat ? `Edit ${cat.name}` : 'Add a cat',
    meta: history(cat),
    fields: [
      { name: 'photo', type: 'photo', value: cat?.photo || '', preview: cat?.photo ? avatar(cat, 'lg') : '' },
      { name: 'name', label: 'Name', required: true, value: cat?.name },
      { name: 'breed', label: 'Breed', value: cat?.breed, placeholder: 'e.g. Domestic shorthair' },
      { name: 'sex', label: 'Sex', type: 'select', options: ['', 'Female', 'Male'], value: cat?.sex || '' },
      { name: 'birthday', label: 'Birthday (or estimate)', type: 'date', clearable: true, value: cat?.birthday },
      { name: 'adopted', label: 'Adopted on', type: 'date', clearable: true, value: (cat && adoptedOf(cat)) || '' },
      { name: 'color', label: 'Colour / markings', value: cat?.color },
      { name: 'microchip', label: 'Microchip no.', value: cat?.microchip },
      { name: 'fivFelv', label: 'FIV/FeLV result', type: 'select', value: (cat && fivFelvOf(cat)?.result) || '',
        options: [{ value: '', label: 'Not tested yet' }, ...FIV_RESULTS.map((r) => ({ value: r, label: r }))] },
      { name: 'fivFelvDate', label: 'FIV/FeLV test date', type: 'date', clearable: true, value: (cat && fivFelvOf(cat)?.date) || '' },
      { name: 'vaccineStatus', label: 'Vaccination status', type: 'select', value: cat?.vaccineStatus || '',
        options: [{ value: '', label: 'Automatic (from Important dates)' },
          ...['Not vaccinated', '1st dose done', '2nd dose done', 'Fully vaccinated'].map((r) => ({ value: r, label: r === 'Fully vaccinated' ? 'Fully vaccinated (3 doses)' : r }))] },
      { name: 'notes', label: 'Notes', type: 'textarea', value: cat?.notes, placeholder: 'Allergies, vet contact, personality…' },
    ],
    onSubmit: async (v) => {
      if (cat) return save('cats', cat.id, v, 'Saved');
      const created = save('cats', null, v, `${v.name.trim()} added`);
      S.catId = created.id;
      store.set('catId', created.id);
    },
    onDelete: cat ? () => remove('cats', cat.id, `${cat.name} removed`) : null,
    deleteLabel: cat ? `Delete ${cat.name} and all records` : 'Delete',
  });
}
ACTIONS.addCat = () => catForm(null);
ACTIONS.editCat = (id) => catForm(S.db.cats.find((c) => c.id === id));

function weightForm(w) {
  const picked = currentCat();
  const needsCat = !w && !picked;
  const cats = S.db.cats.slice().sort((a, b) => a.name.localeCompare(b.name));
  openForm({
    title: w ? 'Edit weight' : picked ? `Log weight — ${picked.name}` : 'Log weight',
    meta: history(w),
    fields: [
      ...(needsCat ? [{ name: 'catId', label: 'Cat', type: 'select', required: true, value: cats[0]?.id, options: cats.map((c) => ({ value: c.id, label: c.name })) }] : []),
      { name: 'kg', label: 'Weight (kg)', type: 'number', step: '0.001', min: 0, required: true, value: w?.kg, placeholder: 'e.g. 0.85 for 850 g' },
      { name: 'date', label: 'Date', type: 'date', required: true, value: w?.date || today() },
      { name: 'notes', label: 'Notes', value: w?.notes },
    ],
    onSubmit: (v) => w ? save('weights', w.id, v, 'Saved')
      : save('weights', null, { ...v, catId: v.catId || S.catId }, 'Weight logged'),
    onDelete: w ? () => remove('weights', w.id, 'Deleted') : null,
  });
}
ACTIONS.addWeight = () => weightForm(null);
ACTIONS.editWeight = (id) => weightForm(S.db.weights.find((x) => x.id === id));

function feedingForm(f) {
  const foods = [...new Set(S.db.feedings.map((x) => x.food).filter(Boolean))];
  openForm({
    title: f ? 'Edit meal' : `Add meal — ${currentCat().name}`,
    meta: history(f),
    fields: [
      { name: 'time', label: 'Time', type: 'time', required: true, value: f?.time || '08:00' },
      { name: 'food', label: 'Food', value: f?.food, placeholder: 'e.g. Wet food (chicken)', suggestions: foods },
      { name: 'amount', label: 'Amount', value: f?.amount, placeholder: 'e.g. 1 pouch, 40 g' },
      { name: 'notes', label: 'Notes', value: f?.notes },
    ],
    onSubmit: (v) => f ? save('feedings', f.id, v, 'Saved')
      : save('feedings', null, { ...v, catId: S.catId }, 'Meal added'),
    onDelete: f ? () => remove('feedings', f.id, 'Deleted') : null,
  });
}
ACTIONS.addFeeding = () => feedingForm(null);
ACTIONS.editFeeding = (id) => feedingForm(S.db.feedings.find((x) => x.id === id));

function eventForm(ev) {
  const types = ev && !EVENT_TYPES.includes(ev.type) ? [...EVENT_TYPES, ev.type] : EVENT_TYPES;
  openForm({
    title: ev ? 'Edit date' : `Add important date — ${currentCat().name}`,
    meta: history(ev),
    fields: [
      { name: 'type', label: 'What', type: 'select', options: types, required: true, value: ev?.type || 'Vaccination' },
      { name: 'date', label: 'Date (done, or planned)', type: 'date', required: true, value: ev?.date || today() },
      { name: 'nextDue', label: 'Next due (optional)', type: 'date', clearable: true, value: ev?.nextDue },
      { name: 'notes', label: 'Notes', value: ev?.notes, placeholder: 'e.g. Brand, vet clinic, batch no.' },
    ],
    onSubmit: (v) => ev ? save('events', ev.id, v, 'Saved')
      : save('events', null, { ...v, catId: S.catId }, 'Date added'),
    onDelete: ev ? () => remove('events', ev.id, 'Deleted') : null,
  });
}
ACTIONS.addEvent = () => eventForm(null);
ACTIONS.editEvent = (id) => eventForm(S.db.events.find((x) => x.id === id));

// ============================================================
// Money
// ============================================================
const EXPENSE_CATS = ['Groceries', 'Rent / Mortgage', 'Utilities', 'Transport & Parking', 'Food & Drinks', 'Pets', 'Health', 'Shopping',
  'Entertainment', 'Bills & subscriptions', 'Commitment', 'Debt', 'Savings', 'Gifts', 'Other'];
const INCOME_CATS = ['Salary', 'Nafkah', 'Bonus', 'Side income', 'General Claims', 'Overtime Claims', 'Other'];

// Renamed spending categories: older entries are moved to the new names once (when the app loads).
const CATEGORY_RENAMES = { 'Dining out': 'Food & Drinks', Transport: 'Transport & Parking' };
let categoriesTidied = false;
function tidyCategories() {
  if (categoriesTidied) return;
  categoriesTidied = true;
  const old = S.db.transactions.filter((t) => t.type === 'expense' && CATEGORY_RENAMES[t.category]);
  if (!old.length) return;
  const batch = writeBatch(fdb);
  for (const t of old) batch.update(doc(fdb, 'transactions', t.id), { category: CATEGORY_RENAMES[t.category] });
  background(batch.commit());
}

// The two of you: whoever has signed in, plus anyone who owns an entry. You come first.
function people() {
  const set = new Set([S.me, ...(S.db.settings.people || [])]);
  for (const t of S.db.transactions) set.add(personOf(t));
  return [...set].filter(Boolean).sort((a, b) => (a === S.me ? -1 : b === S.me ? 1 : a.localeCompare(b)));
}
const personOf = (t) => t.person || t.createdBy || '';
const whoLabel = (p) => (p === S.me ? 'Mine' : p);
// Which person the Money tab is showing: a name, or 'all' for both of you.
function moneyWho() {
  if (S.moneyWho === 'all') return 'all';
  if (S.moneyWho === 'me' || !people().includes(S.moneyWho)) return S.me;
  return S.moneyWho;
}

// ---------- Budget periods ----------
// Each person picks the day their budget month starts (1 = calendar month). A period is named by the
// month it ends in: starting on the 25th, "November" runs 25 Oct – 24 Nov. Days 29–31 fall back to
// the last day of shorter months.
const daysIn = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const dayIn = (key, d) => `${key}-${pad(Math.min(d, daysIn(key)))}`;
const addDays = (iso, n) => { const x = parseDate(iso); x.setDate(x.getDate() + n); return toISO(x); };
const periodStartDay = (p) => Math.min(31, Math.max(1, Number(S.db?.settings?.periodStart?.[p]) || 1));
function periodRange(day, key) {
  if (day <= 1) return { start: `${key}-01`, end: dayIn(key, 31), key, day };
  return { start: dayIn(shiftMonth(key, -1), day), end: addDays(dayIn(key, day), -1), key, day };
}
function currentPeriodKey(day) {
  const m = thisMonth();
  if (day <= 1) return m;
  return today() >= dayIn(m, day) ? shiftMonth(m, 1) : m;
}
const periodOf = (p, offset = S.periodOffset) => {
  const day = periodStartDay(p);
  return periodRange(day, shiftMonth(currentPeriodKey(day), offset));
};
const fmtRange = (r) => `${fmtShort(r.start)} – ${fmtDate(r.end)}`;
const txDate = (t) => t.date || `${t.month}-01`;
const inRange = (d, r) => d >= r.start && d <= r.end;

// Totals for one person (their own period) or 'all' (each person in their own period).
function periodTotals(who, offset = S.periodOffset) {
  const ps = who === 'all' ? people() : [who];
  const ranges = Object.fromEntries(ps.map((p) => [p, periodOf(p, offset)]));
  const tx = S.db.transactions.filter((t) => ranges[personOf(t)] && inRange(txDate(t), ranges[personOf(t)]));
  const sum = (type) => tx.filter((t) => t.type === type).reduce((n, t) => n + t.amount, 0);
  const inc = sum('income'), exp = sum('expense');
  return { tx, inc, exp, left: inc - exp, ranges };
}

// ---------- Pockets ----------
// Each person splits their money into pockets (Main is always there and is the default).
// Income goes into a pocket and spending comes out of one.
const MAIN_POCKET = 'Main';
// Spending from these pockets gets this category automatically (keys are lower-case pocket names).
const POCKET_CATEGORY = { meal: 'Food & Drinks' };
const pocketOf = (t) => t.pocket || MAIN_POCKET;
function pocketsOf(p, includeUsed = true) {
  const list = [MAIN_POCKET, ...(S.db.settings.pockets?.[p] || []).filter((x) => x && x !== MAIN_POCKET)];
  if (includeUsed) for (const t of S.db.transactions) if (personOf(t) === p && !list.includes(pocketOf(t))) list.push(pocketOf(t));
  return list;
}
const pocketSegment = (p, value) => pocketsOf(p).map((k) => ({ value: k, label: k }));

// ---------- Carry-over ----------
// Whatever is left in a pocket at the end of a budget period (income − spending, plus what it carried in)
// carries into the next period. Only money left over carries; an overspent pocket starts the next period at 0.
const round2 = (n) => Math.round(n * 100) / 100;
function periodKeyOf(date, day) {
  const m = date.slice(0, 7);
  if (day <= 1) return m;
  return date >= dayIn(m, day) ? shiftMonth(m, 1) : m;
}
function pocketBalances(p, offset = S.periodOffset) {
  const day = periodStartDay(p);
  const target = shiftMonth(currentPeriodKey(day), offset);
  const byKey = new Map();
  for (const t of S.db.transactions) {
    if (personOf(t) !== p) continue;
    const k = periodKeyOf(txDate(t), day);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  let carry = {};
  let key = [...byKey.keys()].sort()[0] || target;
  for (let guard = 0; key < target && guard < 600; guard++, key = shiftMonth(key, 1)) {
    const next = {};
    const sums = {};
    for (const t of byKey.get(key) || []) (sums[pocketOf(t)] ??= []).push(t);
    for (const k of new Set([...Object.keys(carry), ...Object.keys(sums)])) {
      const left = (carry[k] || 0) + (sums[k] || []).reduce((n, t) => n + (t.type === 'income' ? t.amount : -t.amount), 0);
      if (left > 0.004) next[k] = round2(left);
    }
    carry = next;
  }
  const now = byKey.get(target) || [];
  const out = {};
  for (const k of new Set([...pocketsOf(p), ...Object.keys(carry)])) {
    const mine = now.filter((t) => pocketOf(t) === k);
    const inc = round2(mine.filter((t) => t.type === 'income').reduce((n, t) => n + t.amount, 0));
    const spent = round2(mine.filter((t) => t.type === 'expense').reduce((n, t) => n + t.amount, 0));
    const c = carry[k] || 0;
    out[k] = { carry: c, inc, spent, left: round2(c + inc - spent) };
  }
  return out;
}
const carriedIn = (p, offset = S.periodOffset, pocket = null) =>
  round2(Object.entries(pocketBalances(p, offset)).filter(([k]) => !pocket || k === pocket).reduce((n, [, b]) => n + b.carry, 0));

function pocketsCard(who, tx) {
  const balances = pocketBalances(who);
  const names = Object.keys(balances);
  const rows = names.map((name) => {
    const { carry, inc, spent: out, left } = balances[name];
    const pct = carry + inc > 0 ? Math.min(100, (out / (carry + inc)) * 100) : (out > 0 ? 100 : 0);
    return `<div class="pocket clickable ${S.pocket === name ? 'selected' : ''}" role="button" tabindex="0" data-action="pocketFilter" data-id="${esc(name)}" aria-pressed="${S.pocket === name}">
      <div class="row"><strong class="grow">${esc(name)}${name === MAIN_POCKET ? ' <span class="badge">default</span>' : ''}</strong>
        <span class="amount" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${left < 0 ? 'Over ' : ''}${money(Math.abs(left))}${left < 0 ? '' : ' left'}</span></div>
      <div class="meter ${left < 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <div class="meta">${carry > 0 ? `Carried over ${money(carry)} · ` : ''}In ${money(inc)} · Spent ${money(out)}</div></div>`;
  }).join('');
  return `<div class="card">
    <div class="section-head"><h2>Pockets</h2>${who === S.me ? '<button class="btn ghost small" data-action="openPockets">Edit</button>' : ''}</div>
    ${rows}
    ${names.length === 1 && who === S.me ? '<p class="small muted" style="margin:8px 0 0">Split your money into pockets like Meal, Selfcare or Clothes: tap <strong>Edit</strong>.</p>' : ''}
  </div>`;
}

ACTIONS.pocketFilter = (name) => { S.pocket = S.pocket === name ? null : name; render(); };
ACTIONS.spendPocket = (name) => { S.spendPocket = name || null; render(); };

function renderMoney() {
  const who = moneyWho();
  const period = periodTotals(who);
  const { ranges } = period;
  if (who === 'all' || (S.pocket && !pocketsOf(who).includes(S.pocket))) S.pocket = null;
  // Tapping a pocket shows only that pocket's entries and totals.
  const tx = S.pocket ? period.tx.filter((t) => pocketOf(t) === S.pocket) : period.tx;
  const inc = tx.filter((t) => t.type === 'income').reduce((n, t) => n + t.amount, 0);
  const exp = tx.filter((t) => t.type === 'expense').reduce((n, t) => n + t.amount, 0);
  const carry = who === 'all' ? round2(people().reduce((n, p) => n + carriedIn(p), 0)) : carriedIn(who, S.periodOffset, S.pocket);
  const left = round2(inc + carry - exp);
  const available = inc + carry;
  const showPocket = (t) => pocketsOf(personOf(t)).length > 1;
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');
  const income = tx.filter((t) => t.type === 'income').sort(byDate);
  const expenses = tx.filter((t) => t.type === 'expense').sort(byDate);
  const pct = available > 0 ? Math.min(100, (exp / available) * 100) : (exp > 0 ? 100 : 0);

  // Spending list filter by pocket (only filters the Spending list; the Pockets card filters the whole page).
  const spendPockets = who === 'all' ? [...new Set(people().flatMap((p) => pocketsOf(p)))] : pocketsOf(who);
  if (S.spendPocket && (S.pocket || !spendPockets.includes(S.spendPocket))) S.spendPocket = null;
  const shownSpending = S.spendPocket ? expenses.filter((t) => pocketOf(t) === S.spendPocket) : expenses;
  const countIn = (k) => expenses.filter((t) => pocketOf(t) === k).length;
  const spendChips = !S.pocket && spendPockets.length > 1 ? `<div class="chip-filter" role="group" aria-label="Show spending from pocket">
      <button class="filter-chip" data-action="spendPocket" data-id="" aria-pressed="${!S.spendPocket}">All</button>
      ${spendPockets.map((k) => `<button class="filter-chip" data-action="spendPocket" data-id="${esc(k)}" aria-pressed="${S.spendPocket === k}">${esc(k)}<span class="count">${countIn(k)}</span></button>`).join('')}
    </div>` : '';

  const cats = {};
  for (const t of expenses) cats[t.category || 'Other'] = (cats[t.category || 'Other'] || 0) + t.amount;
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  const txItem = (t, showDate = true) => `<li class="clickable" data-action="editTx" data-id="${t.id}">
    ${who === 'all' ? personDot(personOf(t)) : ''}
    <div class="grow"><div class="title">${esc(t.description || t.category || (t.type === 'income' ? 'Income' : 'Expense'))}</div>
    <div class="meta">${[who === 'all' ? personOf(t) : '', t.description ? t.category : '', t.location ? `at ${t.location}` : '', showDate ? fmtShort(t.date) : '',
      showPocket(t) ? `${t.type === 'income' ? 'into' : 'from'} ${pocketOf(t)}` : '', t.source ? `📲 ${t.source}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    <span class="amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span></li>`;

  const prevIncome = periodTotals(who, S.periodOffset - 1).tx.filter((t) => t.type === 'income');
  // Heading: the exact dates for one person; for Both, the month name (each of you in your own period).
  const range = who === 'all' ? null : ranges[who];
  const heading = range ? fmtRange(range) : fmtMonth(periodOf(S.me).key);
  const subheading = range
    ? (range.day > 1 ? `Budget month starts on the ${ordinal(range.day)}` : 'Calendar month')
    : 'Each of you in your own budget period';
  const tabs = [...people(), 'all'];
  const whose = who === 'all' ? 'Both of you' : who === S.me ? 'Your' : `${who}'s`;

  return `
    <div class="seg money-tabs" role="tablist">${tabs.map((p) => `<button role="tab" data-action="moneyWho" data-id="${esc(p)}"
      aria-selected="${p === who}">${p === 'all' ? '👫 Both' : `${personDot(p)}${esc(whoLabel(p))}`}</button>`).join('')}</div>
    <div class="month-nav">
      <button class="btn icon" data-action="month" data-id="-1" aria-label="Previous period">‹</button>
      <div class="period-title"><h2>${heading}</h2><p>${subheading}</p></div>
      <button class="btn icon" data-action="month" data-id="1" aria-label="Next period">›</button>
    </div>
    ${S.periodOffset !== 0 ? `<p class="center" style="margin:-6px 0 12px"><button class="btn ghost small" data-action="month" data-id="0">Back to current period</button></p>` : ''}
    <div class="stats">
      <div class="stat"><span>Income</span><strong class="amount income">${money(inc)}</strong></div>
      <div class="stat"><span>Spent</span><strong class="amount expense">${money(exp)}</strong></div>
      <div class="stat"><span>${left < 0 ? 'Over by' : 'Left'}</span><strong class="amount" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${money(Math.abs(left))}</strong></div>
    </div>
    ${S.pocket ? `<p class="pocket-filter">Showing the <strong>${esc(S.pocket)}</strong> pocket only <button class="btn ghost small" data-action="pocketFilter" data-id="${esc(S.pocket)}">Show all</button></p>` : ''}
    ${who === 'all' ? `<div class="card"><div class="section-head"><h2>Each of you</h2></div>${people().map((p) => personBalance(p, S.periodOffset)).join('')}</div>` : pocketsCard(who, period.tx)}
    <div class="card">
      <div class="row"><span class="grow small muted">${available > 0 ? `${whose === 'Your' ? 'You have' : whose === 'Both of you' ? 'Together you have' : `${esc(who)} has`} spent ${Math.round((exp / available) * 100)}% of ${carry > 0 ? 'income + carried over' : 'income'}` : 'Add income for this period to see the balance'}</span></div>
      <div class="meter ${exp > available && available > 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      ${!tx.some((t) => t.type === 'income') && prevIncome.length
        ? `<div class="row wrap" style="margin-top:12px"><button class="btn" data-action="copyIncome">Copy last period's income</button></div>` : ''}
    </div>
    ${catRows.length ? `<div class="card"><div class="section-head"><h2>Where it went</h2></div><div class="bars">
      ${catRows.map(([c, v]) => `<div class="bar-row"><span>${esc(c)}</span><div class="meter"><div style="width:${(v / maxCat) * 100}%"></div></div>
        <span class="amount">${money(v)}</span></div>`).join('')}</div></div>` : ''}
    <div class="card"><div class="section-head"><h2>Income<small>${income.length}</small></h2></div>
      ${carry > 0 ? `<ul class="list carry-row"><li><span class="carry-ico" aria-hidden="true">↪</span><div class="grow"><div class="title">Carried over from last period</div>
        <div class="meta">${who === 'all' ? 'Leftovers from each of your pockets' : S.pocket ? `Left in ${esc(S.pocket)} last period` : 'Left in your pockets last period'}</div></div>
        <span class="amount income">+${money(carry)}</span></li></ul>` : ''}
      ${income.length ? `<ul class="list">${income.map((t) => txItem(t)).join('')}</ul>` : carry > 0 ? '' : '<p class="empty">No income added for this period.</p>'}</div>
    <div class="card"><div class="section-head"><h2>Spending<small>${shownSpending.length}</small></h2></div>
      ${spendChips}
      ${shownSpending.length ? spendingByDay(shownSpending, txItem)
        : expenses.length ? `<p class="empty">No spending from ${esc(S.spendPocket)} in this period.</p>`
        : '<p class="empty">No spending recorded yet. Tap ＋ to add.</p>'}</div>
    <div class="fab-space" aria-hidden="true"></div>
    <button class="fab" data-action="addTx" data-id="expense" aria-label="Add spending or income">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
    </button>`;
}

// Spending grouped by day, newest day first.
// Calendar-style date block on the left of each day's spending: "16 · TODAY · NOV", "10 · TUE · NOV".
function dayBlock(d) {
  const date = parseDate(d);
  const isToday = daysUntil(d) === 0;
  const weekday = isToday ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' });
  const month = date.toLocaleDateString(undefined, { month: 'short', year: d.slice(0, 4) === today().slice(0, 4) ? undefined : '2-digit' });
  const full = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `<h3 class="cal-date ${isToday ? 'today' : ''}" aria-label="${esc(full)}">
    <b aria-hidden="true">${date.getDate()}</b><span aria-hidden="true">${esc(weekday)}</span><small aria-hidden="true">${esc(month)}</small></h3>`;
}
function spendingByDay(expenses, txItem) {
  const days = new Map();
  for (const t of expenses) {
    const d = txDate(t);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(t);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, list]) => `<section class="day-group cal">
    ${dayBlock(d)}
    <ul class="list">${list.map((t) => txItem(t, false)).join('')}</ul></section>`).join('');
}

// One person's budget period at a glance (used on Home and in the Both tab).
function personBalance(p, offset = 0) {
  const { inc, exp, ranges } = periodTotals(p, offset);
  const carry = carriedIn(p, offset);
  const left = round2(inc + carry - exp);
  const pct = inc + carry > 0 ? Math.min(100, (exp / (inc + carry)) * 100) : (exp > 0 ? 100 : 0);
  return `<div class="balance clickable" role="button" tabindex="0" data-action="openMoney" data-id="${esc(p)}">
    <div class="row">${personDot(p)}<strong>${esc(p === S.me ? `${p} (you)` : p)}</strong><span class="grow">${roleBadge(p)}</span>
      <span class="amount" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${left < 0 ? 'Over ' : ''}${money(Math.abs(left))}${left < 0 ? '' : ' left'}</span></div>
    <div class="meter ${left < 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
    <div class="meta">${fmtRange(ranges[p])} · Income ${money(inc)}${carry > 0 ? ` · Carried ${money(carry)}` : ''} · Spent ${money(exp)}</div>
  </div>`;
}

ACTIONS.moneyWho = (p) => { S.moneyWho = p === S.me ? 'me' : p; S.pocket = null; S.spendPocket = null; store.set('moneyWho', S.moneyWho); render(); };
ACTIONS.openMoney = (p) => {
  S.tab = 'money'; store.set('tab', 'money');
  S.periodOffset = 0;
  ACTIONS.moneyWho(p);
  window.scrollTo(0, 0);
};

ACTIONS.month = (n) => { S.periodOffset = Number(n) === 0 ? 0 : S.periodOffset + Number(n); render(); };

ACTIONS.copyIncome = async () => {
  const who = moneyWho();
  const prev = periodTotals(who, S.periodOffset - 1).tx.filter((t) => t.type === 'income');
  for (const t of prev) {
    const r = periodOf(personOf(t));
    const date = inRange(today(), r) ? today() : r.start;
    save('transactions', null, {
      type: 'income', amount: t.amount, month: date.slice(0, 7), category: t.category, description: t.description, person: personOf(t), pocket: pocketOf(t), date,
    });
  }
  toast(`Copied ${prev.length} income item${prev.length === 1 ? '' : 's'}`);
};

function txForm(t, type) {
  type = t?.type || type;
  const viewRange = periodOf(moneyWho() === 'all' ? S.me : moneyWho());
  const defaultDate = inRange(today(), viewRange) ? today() : viewRange.start;
  const cats = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  openForm({
    title: `${t ? 'Edit' : 'Add'} ${type === 'income' ? 'income' : 'spending'}`,
    meta: history(t),
    fields: [
      { name: 'type', type: 'segment', label: 'Type', value: type, options: [{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }] },
      { name: 'person', type: 'segment', label: 'Whose', value: t ? personOf(t) : (moneyWho() === 'all' ? S.me : moneyWho()),
        options: people().map((p) => ({ value: p, label: p === S.me ? `Mine (${p})` : `${p}'s` })) },
      { name: 'pocket', type: 'segment', label: 'Pocket', showLabel: true, wrap: true,
        value: t ? pocketOf(t) : (S.pocket || MAIN_POCKET),
        options: pocketSegment(t ? personOf(t) : (moneyWho() === 'all' ? S.me : moneyWho())) },
      { name: 'amount', label: `Amount (${S.db.settings.currency})`, type: 'number', step: '0.01', min: 0, required: true, value: t?.amount },
      { name: 'description', label: 'Description (optional)', value: t?.description, placeholder: type === 'income' ? 'e.g. My salary' : 'e.g. Electricity bill' },
      { name: 'location', label: 'Location (optional)', value: t?.location, placeholder: 'e.g. Aeon Shah Alam',
        suggestions: [...new Set(S.db.transactions.map((x) => x.location).filter(Boolean))].sort() },
      { name: 'category', label: 'Category', type: 'select', options: t?.category && !cats.includes(t.category) ? [...cats, t.category] : cats, value: t?.category || cats[0] },
      { name: 'date', label: 'Date', type: 'date', value: t?.date || defaultDate },
    ],
    onSubmit: (v) => {
      v.date = v.date || defaultDate;
      v.month = v.date.slice(0, 7);
      const who = moneyWho();
      const msg = !inRange(v.date, periodOf(v.person || S.me)) ? 'Saved to a different budget period'
        : who !== 'all' && v.person && v.person !== who ? `Saved to ${v.person === S.me ? 'your' : `${v.person}'s`} tab` : 'Saved';
      return t ? save('transactions', t.id, v, msg) : save('transactions', null, v, msg);
    },
    onDelete: t ? () => remove('transactions', t.id, 'Deleted') : null,
  });
  const modal = $('#modal');
  // Whose → show that person's pockets (back to Main).
  const pocketLabel = () => $('.field-label', modal);
  const setPocketWord = (type) => { if (pocketLabel()) pocketLabel().textContent = type === 'income' ? 'Into pocket' : 'From pocket'; };
  setPocketWord(type);
  modal.querySelectorAll('input[name=person]').forEach((r) => r.addEventListener('change', () => {
    $('[data-seg=pocket]', modal).innerHTML = pocketsOf(r.value).map((k) =>
      `<label><input type="radio" name="pocket" value="${esc(k)}" ${k === MAIN_POCKET ? 'checked' : ''}>${esc(k)}</label>`).join('');
  }));
  modal.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => setPocketWord(r.value)));
  // Swap category options when switching between spending and income.
  modal.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => {
    const list = r.value === 'income' ? INCOME_CATS : EXPENSE_CATS;
    $('select[name=category]', modal).innerHTML = list.map((c) => `<option>${esc(c)}</option>`).join('');
    $('h3', modal).textContent = `${t ? 'Edit' : 'Add'} ${r.value === 'income' ? 'income' : 'spending'}`;
  }));
  // Picking certain pockets for spending sets the matching category (still changeable by hand).
  const autoCategory = () => {
    const kind = $('input[name=type]:checked', modal)?.value;
    const cat = POCKET_CATEGORY[($('input[name=pocket]:checked', modal)?.value || '').toLowerCase()];
    if (kind === 'expense' && cat) $('select[name=category]', modal).value = cat;
  };
  $('form', modal).addEventListener('change', (e) => { if (e.target.name === 'pocket' || e.target.name === 'type') autoCategory(); });
  if (!t) autoCategory();
}
ACTIONS.addTx = (type) => txForm(null, type);
ACTIONS.editTx = (id) => txForm(S.db.transactions.find((x) => x.id === id));

// ============================================================
// Grocery
// ============================================================
// In-stock items that expire tomorrow, today, or already have.
const expiringSoon = () => (S.db?.groceries || [])
  .filter((g) => g.bought && g.expiry && daysUntil(g.expiry) <= 1)
  .sort((a, b) => a.expiry.localeCompare(b.expiry));

function expiryBadge(date) {
  const d = daysUntil(date);
  if (d < 0) return `<span class="badge danger">Expired ${fmtShort(date)}</span>`;
  if (d === 0) return `<span class="badge danger">Expires today</span>`;
  if (d === 1) return `<span class="badge warn">Expires tomorrow</span>`;
  if (d <= 7) return `<span class="badge">Expires in ${d} days</span>`;
  return `<span class="badge">Exp ${fmtShort(date)}</span>`;
}

// ---------- Grocery item → emoji + section (English and Malay names; first match wins) ----------
const GROCERY_SECTIONS = ['Dairy & Eggs', 'Meat & Seafood', 'Vegetables', 'Fruits', 'Bakery', 'Rice, Noodles & Dry', 'Cooking & Sauces',
  'Drinks', 'Snacks', 'Frozen', 'Household', 'Personal care', 'Health', 'Pets', 'Other'];
const GROCERY_KINDS = [
  // Pets
  [/cat ?food|makanan kucing|kibble|whiskas|royal canin|babycat|fancy feast|friskies|\bme-?o\b|felix|purina|sheba|cat treat|churu|wet food|dry food/, '🐱', 'Pets'],
  [/litter|pasir kucing|tofu sand/, '🐾', 'Pets'],
  [/dog food|pet food|\bpets?\b/, '🐾', 'Pets'],
  // Health
  [/plaster|bandage|band-aid/, '🩹', 'Health'],
  [/panadol|paracetamol|medicine|\bubat\b(?! gigi| nyamuk)|vitamin|supplement|minyak angin|antiseptic|dettol|thermometer|face ?mask/, '💊', 'Health'],
  // Personal care
  [/toothpaste|ubat gigi|colgate|darlie|sensodyne|toothbrush|berus gigi|floss/, '🪥', 'Personal care'],
  [/shampoo|syampu|conditioner|body ?wash|lotion|sunscreen|deodorant|facial|cleanser|moisturi[sz]er|sabun mandi/, '🧴', 'Personal care'],
  [/tissue|tisu|toilet ?(roll|paper)|kitchen towel|wet ?wipes/, '🧻', 'Personal care'],
  [/razor|shaver|pencukur/, '🪒', 'Personal care'],
  [/sanitary|tuala wanita|diaper|lampin|cotton bud/, '🧷', 'Personal care'],
  // Household
  [/dish ?wash|basuh pinggan|sunlight|sponge|\bspan\b|scrub/, '🧽', 'Household'],
  [/detergent|softener|downy|breeze|dynamo|clorox|bleach|peluntur|floor clean|pencuci|cecair/, '🧺', 'Household'],
  [/garbage|trash|plastik sampah|bin ?bag/, '🗑️', 'Household'],
  [/freshener|pewangi|glade|ambi ?pur|febreze/, '🌸', 'Household'],
  [/bulb|mentol|lampu/, '💡', 'Household'],
  [/batter(y|ies)|bateri/, '🔋', 'Household'],
  [/insect|ridsect|ubat nyamuk|mosquito|shieldtox/, '🦟', 'Household'],
  [/foil|cling ?wrap|baking paper|ziplock|plastic bag|beg plastik/, '📦', 'Household'],
  [/\bsoap\b|\bsabun\b|hand ?wash/, '🧼', 'Personal care'],
  // Frozen
  [/ice ?cream|aiskrim/, '🍦', 'Frozen'],
  [/nugget/, '🍗', 'Frozen'],
  [/fries|kentang goreng/, '🍟', 'Frozen'],
  [/pizza/, '🍕', 'Frozen'],
  [/dumpling|gyoza|dim ?sum/, '🥟', 'Frozen'],
  [/fish ?ball|bebola|fishcake|yong tau/, '🍢', 'Frozen'],
  [/\bice\b|\bais\b|frozen|beku/, '🧊', 'Frozen'],
  // Cooking specifics that would otherwise match something else
  [/santan|coconut milk|coconut cream/, '🥥', 'Cooking & Sauces'],
  [/soy ?sauce|kicap|oyster sauce|sos tiram|sauce|\bsos\b|ketchup|mayo|vinegar|cuka|sambal/, '🫙', 'Cooking & Sauces'],
  [/lada hitam|lada putih|black pepper|white pepper|\bpepper\b/, '🧂', 'Cooking & Sauces'],
  [/stock cube|kiub|maggi cube|ajinomoto|\bmsg\b/, '🧂', 'Cooking & Sauces'],
  [/corn ?flakes|koko krunch|cereal|\boats?\b|granola|muesli|bijirin/, '🥣', 'Rice, Noodles & Dry'],
  [/corn ?flour|tepung jagung|\bflour\b|tepung/, '🌾', 'Rice, Noodles & Dry'],
  // Dairy & Eggs
  [/cheese|keju/, '🧀', 'Dairy & Eggs'],
  [/butter(?!cup)|mentega|margarine|planta|buttercup/, '🧈', 'Dairy & Eggs'],
  [/yogh?urt|yakult|vitagen/, '🥣', 'Dairy & Eggs'],
  [/eggplant|terung|brinjal/, '🍆', 'Vegetables'],
  [/\beggs?\b|telur/, '🥚', 'Dairy & Eggs'],
  [/milk|susu|dutch lady|farm fresh|marigold|goodday|fernleaf|\bcream\b|krim/, '🥛', 'Dairy & Eggs'],
  // Meat & Seafood
  [/sausage|sosej|hot ?dog|frankfurter/, '🌭', 'Meat & Seafood'],
  [/chicken|ayam|drumstick|wing/, '🍗', 'Meat & Seafood'],
  [/beef|daging|steak|mince|lamb|kambing|mutton|patty/, '🥩', 'Meat & Seafood'],
  [/prawn|udang|shrimp/, '🦐', 'Meat & Seafood'],
  [/squid|sotong|calamari/, '🦑', 'Meat & Seafood'],
  [/crab|ketam/, '🦀', 'Meat & Seafood'],
  [/fish|ikan|salmon|tuna|sardin|kembung|bilis|anchov|\bcod\b|dory|tenggiri|siakap|keli|kerapu/, '🐟', 'Meat & Seafood'],
  // Vegetables
  [/tomato/, '🍅', 'Vegetables'],
  [/cucumber|timun/, '🥒', 'Vegetables'],
  [/sweet potato|keledek|ubi/, '🍠', 'Vegetables'],
  [/potato|kentang/, '🥔', 'Vegetables'],
  [/garlic|bawang putih/, '🧄', 'Vegetables'],
  [/onion|bawang|shallot/, '🧅', 'Vegetables'],
  [/chill?i|cili|cabai|\blada\b/, '🌶️', 'Vegetables'],
  [/carrot|lobak merah/, '🥕', 'Vegetables'],
  [/broccoli|brokoli|cauliflower|kubis bunga/, '🥦', 'Vegetables'],
  [/\bcorn\b|jagung/, '🌽', 'Vegetables'],
  [/mushroom|cendawan/, '🍄', 'Vegetables'],
  [/ginger|halia|lengkuas|serai|lemongrass|kunyit|turmeric/, '🫚', 'Vegetables'],
  [/bean ?sprout|tauge|taugeh/, '🌱', 'Vegetables'],
  [/long bean|kacang panjang|buncis|french bean|\bpeas?\b/, '🫛', 'Vegetables'],
  [/pumpkin|\blabu\b/, '🎃', 'Vegetables'],
  [/lettuce|salad|spinach|bayam|kangkung|sawi|cabbage|kobis|kubis|pak ?choy|bok ?choy|kailan|choy ?sum|bendi|okra|lady'?s? ?finger|vegetable|sayur|daun|herb|celery|saderi|parsley|coriander|ketumbar|pudina|mint/, '🥬', 'Vegetables'],
  // Fruits
  [/pineapple|nanas/, '🍍', 'Fruits'],
  [/apple|epal/, '🍎', 'Fruits'],
  [/banana|pisang/, '🍌', 'Fruits'],
  [/watermelon|tembikai/, '🍉', 'Fruits'],
  [/mandarin|orange|oren|limau mandarin/, '🍊', 'Fruits'],
  [/lemon|\blimes?\b|limau/, '🍋', 'Fruits'],
  [/grape|anggur/, '🍇', 'Fruits'],
  [/strawberr/, '🍓', 'Fruits'],
  [/blueberr/, '🫐', 'Fruits'],
  [/mango|mangga/, '🥭', 'Fruits'],
  [/coconut|kelapa/, '🥥', 'Fruits'],
  [/avocado/, '🥑', 'Fruits'],
  [/\bpears?\b|\bpir\b/, '🍐', 'Fruits'],
  [/cherr/, '🍒', 'Fruits'],
  [/kiwi/, '🥝', 'Fruits'],
  [/peach/, '🍑', 'Fruits'],
  [/melon/, '🍈', 'Fruits'],
  [/papaya|betik|durian|rambutan|langsat|jambu|guava|dragon ?fruit|buah naga|\bfruits?\b|\bbuah\b/, '🍑', 'Fruits'],
  // Bakery
  [/croissant/, '🥐', 'Bakery'],
  [/bagel/, '🥯', 'Bakery'],
  [/\bcakes?\b|\bkek\b|muffin|cupcake/, '🍰', 'Bakery'],
  [/bread|\broti\b|\bbuns?\b|gardenia|massimo|sandwich|baguette/, '🍞', 'Bakery'],
  // Rice, noodles & dry goods
  [/\brice\b|beras|\bnasi\b/, '🍚', 'Rice, Noodles & Dry'],
  [/pasta|spaghetti|macaroni|penne|fusilli|lasagn/, '🍝', 'Rice, Noodles & Dry'],
  [/\bmee\b|\bmi\b|noodle|maggi|bihun|kuey ?teow|ramen|udon|instant/, '🍜', 'Rice, Noodles & Dry'],
  [/sugar|\bgula\b/, '🍬', 'Rice, Noodles & Dry'],
  [/honey|\bmadu\b/, '🍯', 'Rice, Noodles & Dry'],
  [/\bjam\b|nutella|peanut butter|\bkaya\b|spread/, '🫙', 'Rice, Noodles & Dry'],
  [/canned|\btin\b|\bcan\b|baked beans/, '🥫', 'Rice, Noodles & Dry'],
  // Cooking & sauces
  [/\boil\b|minyak/, '🫗', 'Cooking & Sauces'],
  [/\bsalt\b|garam/, '🧂', 'Cooking & Sauces'],
  [/soy ?sauce|kicap|oyster sauce|sos tiram|sauce|\bsos\b|ketchup|mayo|vinegar|cuka|sambal|paste|pes\b/, '🫙', 'Cooking & Sauces'],
  [/spice|rempah|curry|\bkari\b|serbuk|stock/, '🧂', 'Cooking & Sauces'],
  // Drinks
  [/coffee|kopi|nescafe|espresso|latte/, '☕', 'Drinks'],
  [/\btea\b|\bteh\b|lipton|\bboh\b|green tea/, '🍵', 'Drinks'],
  [/milo|horlicks|ovaltine|cocoa/, '🥤', 'Drinks'],
  [/juice|\bjus\b/, '🧃', 'Drinks'],
  [/water|air mineral|mineral|spritzer|cactus|\bair\b/, '💧', 'Drinks'],
  [/soda|coke|cola|pepsi|100 ?plus|sprite|f&n|drink|minuman|kordial|cordial|ribena|sirap/, '🥤', 'Drinks'],
  // Snacks
  [/chocolate|coklat|kitkat|cadbury|m&m/, '🍫', 'Snacks'],
  [/biscuit|biskut|cookie|cracker|jacob|hup seng|oreo/, '🍪', 'Snacks'],
  [/nuts?\b|kacang tanah|peanut|almond|cashew|pistachio/, '🥜', 'Snacks'],
  [/\bkacang\b|lentil|\bdh?al\b|chickpea/, '🫘', 'Rice, Noodles & Dry'],
  [/chips|crisps|kerepek|keropok|snack|mister potato|pringles|popcorn/, '🍿', 'Snacks'],
  [/candy|gula-gula|sweets|gumm(y|ies)|lollipop/, '🍬', 'Snacks'],
];
const kindCache = new Map();
function groceryKind(name) {
  const n = String(name || '').toLowerCase();
  if (!kindCache.has(n)) {
    const hit = GROCERY_KINDS.find(([re]) => re.test(n));
    kindCache.set(n, hit ? { emoji: hit[1], section: hit[2] } : { emoji: '🛒', section: 'Other' });
  }
  return kindCache.get(n);
}

const groceryMeta = (g) => [g.quantity, g.note].filter(Boolean).map(esc).join(' · ');
const INFO_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><path d="M12 7.6h.01"></path></svg>';

// One grocery card: emoji · name & quantity · (expiry) · ⓘ · tick. Swipe left to remove.
function groceryItemCard(g) {
  const { emoji } = groceryKind(g.name);
  const meta = groceryMeta(g);
  return `<li class="g-item" data-id="${g.id}">
    <div class="g-under" aria-hidden="true">Remove</div>
    <div class="g-card">
      <span class="g-emoji" aria-hidden="true">${emoji}</span>
      <button class="g-main" data-action="editGrocery" data-id="${g.id}" aria-label="Edit ${esc(g.name)}">
        <span class="title">${esc(g.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</button>
      ${g.bought ? (g.expiry ? expiryBadge(g.expiry) : `<button class="btn ghost small" data-action="addExpiry" data-id="${g.id}">＋ Expiry</button>`) : ''}
      <button class="g-info" data-action="groceryInfo" data-id="${g.id}" aria-label="Details for ${esc(g.name)}">${INFO_ICON}</button>
      <button class="check ${g.bought ? 'on' : ''}" data-action="toggleGrocery" data-id="${g.id}"
        aria-label="${g.bought ? `${esc(g.name)} ran out: put back on the shopping list` : `Mark ${esc(g.name)} as bought`}">✓</button>
    </div></li>`;
}

function renderGrocery() {
  const items = S.db.groceries;
  const newestFirst = (a, b) => b.addedDate.localeCompare(a.addedDate) || (b.createdAt || '').localeCompare(a.createdAt || '');
  const needed = items.filter((g) => !g.bought).sort(newestFirst);
  // In stock: soonest expiry first, then items without an expiry date (newest purchase first).
  const inStock = items.filter((g) => g.bought).sort((a, b) =>
    (a.expiry ? 0 : 1) - (b.expiry ? 0 : 1) || (a.expiry || '').localeCompare(b.expiry || '')
    || (b.boughtDate || '').localeCompare(a.boughtDate || ''));
  const expiring = expiringSoon();
  // To buy, grouped by section (Dairy & Eggs, Vegetables, …).
  const sections = GROCERY_SECTIONS.map((sec) => [sec, needed.filter((g) => groceryKind(g.name).section === sec)]).filter(([, list]) => list.length);

  return `
    <div class="g-hero">
      <h2>Groceries</h2>
      <span class="g-chip">${needed.length ? `🛒 ${needed.length} to buy` : '✓ All stocked'}</span>
    </div>
    ${expiring.length ? `<div class="card alert">
      <div class="section-head"><h2>⚠️ Expiring soon<small>${expiring.length}</small></h2></div>
      <ul class="list">${expiring.map((g) => `<li class="clickable" data-action="editGrocery" data-id="${g.id}">
        <span class="g-emoji sm" aria-hidden="true">${groceryKind(g.name).emoji}</span>
        <div class="grow"><div class="title">${esc(g.name)}</div><div class="meta">Expiry ${fmtDate(g.expiry)}</div></div>${expiryBadge(g.expiry)}</li>`).join('')}</ul>
    </div>` : ''}
    <form class="g-add" id="groceryAdd">
      <input name="name" placeholder="What ran out? e.g. Milk" required autocomplete="off" list="groceryHistory" aria-label="Item">
      <input name="quantity" class="qty" placeholder="Qty" autocomplete="off" aria-label="Quantity">
      <button class="g-add-btn" type="submit" aria-label="Add to list">＋</button>
      <datalist id="groceryHistory">${[...new Set(items.map((g) => g.name))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    </form>
    ${sections.length ? sections.map(([sec, list]) => `<section class="g-section">
        <h3 class="g-head">${esc(sec)}</h3><ul class="g-list">${list.map(groceryItemCard).join('')}</ul></section>`).join('')
      : '<p class="empty">Nothing to buy. The pantry is stocked! 🎉</p>'}
    <section class="g-section g-stock">
      <div class="g-head-row"><h3 class="g-head">🏠 In stock · ${inStock.length}</h3><button class="btn ghost small" data-action="addStock">＋ Add</button></div>
      ${inStock.length ? `<ul class="g-list">${inStock.map(groceryItemCard).join('')}</ul>`
        : '<p class="empty">Items you tick as bought land here. Add an expiry date and you\'ll be warned the day before.</p>'}
    </section>
    <p class="small muted center">Swipe an item left to remove it · ⓘ shows who added it and when</p>`;
}

// ⓘ: who added it, when, and the rest of its story.
ACTIONS.groceryInfo = (id) => {
  const g = S.db.groceries.find((x) => x.id === id);
  if (!g) return;
  const { emoji, section } = groceryKind(g.name);
  const when = (iso) => (iso ? `${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${ago(iso)}` : '');
  const rows = [
    ['Added by', g.createdBy ? `${personDot(g.createdBy)} ${esc(g.createdBy)}` : '—'],
    ['Added on', esc(when(g.createdAt))],
    !g.bought && ['Out of stock since', esc(fmtDate(g.addedDate))],
    g.bought && ['Bought by', (g.boughtBy || g.updatedBy) ? `${personDot(g.boughtBy || g.updatedBy)} ${esc(g.boughtBy || g.updatedBy)}` : '—'],
    g.bought && ['Bought on', esc(fmtDate(g.boughtDate))],
    g.expiry && ['Expires', esc(fmtDate(g.expiry))],
    g.quantity && ['Quantity', esc(g.quantity)],
    g.note && ['Note', esc(g.note)],
    wasEdited(g) && ['Last changed', `${esc(g.updatedBy)} · ${esc(ago(g.updatedAt))}`],
    ['Section', `${emoji} ${esc(section)}`],
  ].filter(Boolean);
  const modal = $('#modal');
  modal.innerHTML = `<form method="dialog">
    <div class="info-head"><span class="g-emoji lg" aria-hidden="true">${emoji}</span><h3 tabindex="-1" autofocus>${esc(g.name)}</h3></div>
    <dl class="info-list">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <div class="modal-actions"><button type="button" class="btn" data-action="editGroceryFromInfo" data-id="${g.id}">Edit</button>
      <button class="btn primary" value="close">Close</button></div>
  </form>`;
  modal.showModal();
};
ACTIONS.editGroceryFromInfo = (id) => { $('#modal').close(); ACTIONS.editGrocery(id); };

// Remove with Undo (used by swipe).
function removeGroceryWithUndo(id) {
  const g = S.db.groceries.find((x) => x.id === id);
  if (!g) return;
  const { id: _, ...data } = g;
  background(deleteDoc(doc(fdb, 'groceries', id)));
  toastAction(`${g.name} removed`, 'Undo', () => background(setDoc(doc(fdb, 'groceries', id), data)));
}

// Swipe a grocery card left to remove it. Vertical scrolling still works (touch-action: pan-y on the card).
let swipe = null;
let lastSwipeEnd = 0;
document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.g-card');
  if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
  swipe = { card, item: card.closest('.g-item'), x: e.clientX, y: e.clientY, dx: 0, active: false, pointer: e.pointerId };
});
document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.pointer) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swipe.active = true;
      swipe.item.classList.add('swiping');
      try { swipe.card.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    } else if (Math.abs(dy) > 12 || dx > 12) { swipe = null; return; } else return;
  }
  swipe.dx = Math.min(0, dx);
  swipe.card.style.transform = `translateX(${swipe.dx}px)`;
});
function endSwipe() {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;
  lastSwipeEnd = Date.now();
  const w = s.card.offsetWidth;
  s.card.style.transition = 'transform .18s ease';
  if (s.dx < -w * 0.35) {
    s.card.style.transform = `translateX(${-w - 24}px)`;
    setTimeout(() => removeGroceryWithUndo(s.item.dataset.id), 170);
  } else {
    s.card.style.transform = '';
    setTimeout(() => { s.card.style.transition = ''; s.item.classList.remove('swiping'); }, 200);
  }
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);
// The tap that ends a swipe shouldn't also open the item.
document.addEventListener('click', (e) => {
  if (Date.now() - lastSwipeEnd < 400 && e.target.closest('.g-card')) { e.stopPropagation(); e.preventDefault(); }
}, true);

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'groceryAdd') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target).entries());
  if (!v.name.trim()) return;
  const existing = S.db.groceries.find((g) => !g.bought && g.name.toLowerCase() === v.name.trim().toLowerCase());
  if (existing) { toast(`${existing.name} is already on the list`); return; }
  try {
    e.target.reset(); // clear the boxes before the list refreshes (it keeps whatever is typed)
    await save('groceries', null, { ...v, addedDate: today() }, `${v.name.trim()} added`);
    $('#groceryAdd input[name=name]')?.focus();
  } catch (ex) { toast(ex.message); }
});

ACTIONS.toggleGrocery = (id) => {
  const g = S.db.groceries.find((x) => x.id === id);
  return g.bought
    ? save('groceries', id, { bought: false, boughtDate: '', boughtBy: '', expiry: '', addedDate: today() }, `${g.name} back on the shopping list`)
    : save('groceries', id, { bought: true, boughtDate: today(), boughtBy: S.me }, `${g.name} moved to In stock`);
};

ACTIONS.addExpiry = (id) => {
  const g = S.db.groceries.find((x) => x.id === id);
  openForm({
    title: `Expiry date: ${g.name}`,
    fields: [{ name: 'expiry', label: 'Expires on', type: 'date', required: true, value: g.expiry || '' }],
    onSubmit: (v) => save('groceries', id, v, 'Expiry date saved'),
  });
};

ACTIONS.addStock = () => openForm({
  title: 'Add to In stock',
  fields: [
    { name: 'name', label: 'Item', required: true, suggestions: [...new Set(S.db.groceries.map((g) => g.name))] },
    { name: 'quantity', label: 'Quantity' },
    { name: 'boughtDate', label: 'Bought on', type: 'date', required: true, value: today() },
    { name: 'expiry', label: 'Expiry date (optional)', type: 'date', clearable: true },
    { name: 'note', label: 'Note', placeholder: 'e.g. brand, where it is kept' },
  ],
  onSubmit: (v) => save('groceries', null, { ...v, bought: true, boughtBy: S.me, addedDate: v.boughtDate || today() }, `${v.name.trim()} added to In stock`),
});

ACTIONS.editGrocery = (id) => {
  const g = S.db.groceries.find((x) => x.id === id);
  openForm({
    title: 'Edit item',
    meta: history(g),
    fields: [
      { name: 'name', label: 'Item', required: true, value: g.name },
      { name: 'quantity', label: 'Quantity', value: g.quantity },
      { name: 'note', label: 'Note', value: g.note, placeholder: 'e.g. brand, store' },
      ...(g.bought ? [
        { name: 'boughtDate', label: 'Bought on', type: 'date', required: true, value: g.boughtDate },
        { name: 'expiry', label: 'Expiry date (optional)', type: 'date', clearable: true, value: g.expiry },
      ] : [
        { name: 'addedDate', label: 'Ran out on', type: 'date', required: true, value: g.addedDate },
      ]),
    ],
    onSubmit: (v) => save('groceries', id, v, 'Saved'),
    onDelete: () => remove('groceries', id, 'Removed'),
    deleteLabel: g.bought ? 'Remove (used up / thrown away)' : 'Remove',
  });
};

// ============================================================
// Refresh app (Settings): get the newest version without waiting for the phone's cache
// ============================================================
const APP_FILES = ['./', './index.html', './app.js', './styles.css', './version.js', './firebase-config.js', './manifest.webmanifest', './icon.svg'];

async function latestVersion() {
  const res = await fetch(`./version.js?check=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not check');
  return (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1] || null;
}

ACTIONS.forceRefresh = async (_, btn) => {
  const label = btn.querySelector('.menu-label') || btn;
  btn.disabled = true;
  label.textContent = 'Checking…';
  let latest;
  try {
    latest = await latestVersion();
  } catch {
    // Offline: reloading now could leave the app unable to start, so stop here.
    btn.disabled = false;
    label.textContent = 'Refresh app';
    toast("No connection. Can't refresh right now.");
    return;
  }
  label.textContent = latest && latest !== APP_VERSION ? `Updating to V${latest}…` : 'Refreshing…';
  try { sessionStorage.setItem('refreshedFrom', APP_VERSION); } catch { /* ignore */ }
  // Re-download every app file, replacing the copies the phone has saved, then reload.
  await Promise.allSettled(APP_FILES.map((u) => fetch(u, { cache: 'reload' })));
  location.reload();
};

// After a refresh, say what happened.
(() => {
  let from = null;
  try { from = sessionStorage.getItem('refreshedFrom'); sessionStorage.removeItem('refreshedFrom'); } catch { /* ignore */ }
  if (from) setTimeout(() => toast(from !== APP_VERSION ? `Updated to V${APP_VERSION} 🎉` : `You're on the latest version (V${APP_VERSION})`), 600);
})();

// ============================================================
// Auto-add from Apple Pay (iPhone Shortcuts "Transaction" automation)
// The automation opens …/?spend=<Amount>&at=<Merchant>; the signed-in app adds it as spending
// (Main pocket, today, best-guess category, tagged "Apple Pay"). No password lives in the Shortcut.
// ============================================================
const APP_URL = `${location.origin}${location.pathname}`;
let pendingCapture = null;
(() => {
  const q = new URLSearchParams(location.search);
  if (!q.has('spend')) return;
  pendingCapture = { amount: q.get('spend') || '', merchant: q.get('at') || '', via: q.get('via') || 'Apple Pay', test: q.has('test') };
  // Drop the details from the address so a reload or reopened tab can't add it twice.
  window.history.replaceState(null, '', location.pathname);
})();

// "RM12.50", "RM 1,234.50", "12,50" → number
function parseAmount(text) {
  let t = String(text).replace(/[^\d.,]/g, '');
  if (t.includes(',') && !t.includes('.') && /,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  return Number(t.replace(/,/g, ''));
}
const tidyMerchant = (m) => {
  const t = String(m).replace(/\s+/g, ' ').trim().slice(0, 120);
  return t && t === t.toUpperCase() ? t.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : t;
};
const MERCHANT_CATEGORIES = [
  [/grab|parking|park\b|petrol|shell|petronas|caltex|bhpetrol|setel|touch ?n ?go|\btng\b|toll|plus\b|mrt|lrt|ktm|rapid|uber|indrive|airasia ride/i, 'Transport & Parking'],
  [/starbucks|coffee|kopi|caf[eé]|zus|tealive|chagee|boost juice|mcd|mcdonald|kfc|burger|pizza|domino|sushi|nasi|mamak|restoran|restaurant|food|bakery|secret recipe|subway|texas|marrybrown|dunkin|baskin|llao|mixue|foodpanda|grabfood/i, 'Food & Drinks'],
  [/aeon|tesco|lotus|giant|mydin|jaya grocer|village grocer|speedmart|7-?eleven|7 eleven|kk ?mart|family ?mart|econsave|nsk|hero|grocer|mart\b|supermarket|hypermarket/i, 'Groceries'],
  [/watson|guardian|pharmac|farmasi|clinic|klinik|hospital|caring|alpro|big pharmacy|dental|optical/i, 'Health'],
  [/\bpet|petsmore|pets wonderland|vet\b|veterinar|kucing|cat food/i, 'Pets'],
  [/tnb|tenaga|unifi|maxis|celcom|digi|u mobile|yes\b|air selangor|syabas|indah water|astro/i, 'Utilities'],
  [/netflix|spotify|apple\.com|icloud|google|youtube|disney|viu|prime video/i, 'Bills & subscriptions'],
  [/shopee|lazada|uniqlo|zara|h&m|ikea|mr ?diy|daiso|cotton on|padini|sephora|decathlon|harvey norman|courts/i, 'Shopping'],
  [/cinema|gsc|tgv|mbo|bowling|karaoke|theme park/i, 'Entertainment'],
];
const guessCategory = (merchant) => (MERCHANT_CATEGORIES.find(([re]) => re.test(merchant)) || [null, 'Other'])[1];

function processCapture() {
  if (!pendingCapture || !S.me) return;
  const cap = pendingCapture;
  pendingCapture = null;
  const amount = parseAmount(cap.amount);
  const merchant = tidyMerchant(cap.merchant);
  if (!(amount > 0)) { toast("Couldn't read the amount from Apple Pay, so nothing was added."); return; }
  if (cap.test) { toast(`✅ Auto-add works! It would add ${money(amount)}${merchant ? ` · ${merchant}` : ''} (test, not saved).`); return; }
  const date = today();
  save('transactions', null, {
    type: 'expense', amount, date, month: date.slice(0, 7), person: S.me, pocket: MAIN_POCKET,
    category: guessCategory(merchant), description: merchant, source: String(cap.via).slice(0, 30) || 'Apple Pay',
  }, `📲 Added ${money(amount)}${merchant ? ` · ${merchant}` : ''}`);
  S.tab = 'money'; store.set('tab', 'money');
  S.moneyWho = 'me'; S.periodOffset = 0; S.pocket = null; S.spendPocket = null;
  render();
}

ACTIONS.openAutoAdd = fromMenu(() => {
  const modal = $('#modal');
  const link = `${APP_URL}?spend=`;
  modal.innerHTML = `<form method="dialog" class="howto">
    <h3 tabindex="-1" autofocus>📲 Auto-add from Apple Pay</h3>
    <p class="small muted" style="margin-top:-8px">Each time you pay by tapping your card with <strong>Apple Pay</strong>, your iPhone opens Our Home and the spending is added to your <strong>Main</strong> pocket (category guessed; edit it any time). MAE QR / DuitNow payments still need ＋.</p>
    <ol>
      <li>Open the <strong>Shortcuts</strong> app → <strong>Automation</strong> → <strong>＋</strong> → <strong>Transaction</strong>.</li>
      <li>Choose your card(s), keep <strong>When I tap</strong>, pick <strong>Run Immediately</strong>, then <strong>Next</strong> → <strong>New Blank Automation</strong>.</li>
      <li>Add the action <strong>URL Encode</strong>. Tap its blue input and choose <strong>Shortcut Input</strong> → <strong>Merchant</strong>.</li>
      <li>Add the action <strong>Text</strong> and build this line (tap <em>Copy start</em> below and paste it first):
        <div class="howto-link"><code>${esc(link)}</code><span class="var">Amount</span><code>&amp;at=</code><span class="var">URL Encoded Text</span></div>
        <span class="small muted">For <em>Amount</em>: tap to insert a variable → Shortcut Input → <strong>Amount</strong>.</span></li>
      <li>Add the action <strong>Open URLs</strong> (it uses the Text automatically). Tap <strong>Done</strong>.</li>
      <li>Open this page in <strong>Safari</strong> once and sign in there too — the automation opens Safari.</li>
    </ol>
    <div class="row wrap" style="gap:8px;margin:4px 0 8px">
      <button type="button" class="btn" id="copyLink">Copy start</button>
      <button type="button" class="btn" id="tryLink">Try it</button>
    </div>
    <p class="form-error" id="howtoMsg"></p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn primary" value="close">Close</button></div>
  </form>`;
  $('#copyLink', modal).onclick = async () => {
    try { await navigator.clipboard.writeText(link); $('#howtoMsg', modal).textContent = 'Copied. Paste it into the Text action.'; }
    catch { $('#howtoMsg', modal).textContent = `Copy this: ${link}`; }
  };
  $('#tryLink', modal).onclick = () => { location.href = `${APP_URL}?spend=RM1.00&at=TEST%20SHOP&test=1`; };
  modal.showModal();
});

// ============================================================
// Boot
// ============================================================
onAuthStateChanged(auth, (user) => {
  if (user) {
    S.me = displayName(user);
    $('#app').innerHTML = '<div class="loading">Loading…</div>';
    startSync();
  } else {
    stopSync();
    S.me = null;
    S.db = null;
    renderLogin();
  }
});
