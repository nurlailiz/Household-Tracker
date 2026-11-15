import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { firebaseConfig, USERNAME_DOMAIN } from './firebase-config.js';

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
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
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
  month: thisMonth(),
};

// Field types per collection: used to clean form values before saving.
const SCHEMA = {
  cats: { name: 'str!', breed: 'str', sex: 'str', birthday: 'str', color: 'str', microchip: 'str', notes: 'str', photo: 'str' },
  weights: { catId: 'str!', date: 'str!', kg: 'num!', notes: 'str' },
  feedings: { catId: 'str!', time: 'str!', food: 'str', amount: 'str', notes: 'str' },
  events: { catId: 'str!', type: 'str!', date: 'str!', nextDue: 'str', notes: 'str' },
  transactions: { type: 'str!', amount: 'num!', month: 'str!', date: 'str', category: 'str', description: 'str', person: 'str' },
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
    if (!waiting.size) render();
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
function openForm({ title, fields, submitLabel = 'Save', onSubmit, onDelete, deleteLabel = 'Delete', confirmDelete = true, meta = '' }) {
  const modal = $('#modal');
  const fieldHtml = (f) => {
    const v = f.value ?? '';
    const req = f.required ? 'required' : '';
    const id = 'f_' + f.name;
    if (f.type === 'segment') {
      return `<div class="seg" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map((o) =>
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
    return `<label class="field" for="${id}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${input}</label>`;
  };

  modal.innerHTML = `<form method="dialog" novalidate>
    <h3>${esc(title)}</h3>
    ${meta}
    ${fields.map(fieldHtml).join('')}
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
    </form></div>`;
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

function render() {
  if (!S.db) return;
  const scroll = window.scrollY;
  const active = document.activeElement?.closest('#groceryAdd') ? document.activeElement.name : null;
  const draft = $('#groceryAdd') ? Object.fromEntries(new FormData($('#groceryAdd')).entries()) : null;
  const body = { home: renderHome, cats: renderCats, money: renderMoney, grocery: renderGrocery }[S.tab] || renderHome;
  $('#app').innerHTML = `
    <header class="topbar">
      <h1><img src="./icon.svg" alt="">Our Home</h1>
      <span class="who">${personDot(S.me)}${esc(S.me)}</span>
      <button class="btn icon ghost" data-action="activity" title="Recent activity" aria-label="Recent activity">🕘</button>
      <button class="btn icon ghost" data-action="settings" title="Settings" aria-label="Settings">⚙️</button>
    </header>
    <nav class="tabs">${TABS.map((t) => `<button data-tab="${t.id}" ${S.tab === t.id ? 'aria-current="page"' : ''}>
      ${t.id === 'grocery' && expiringSoon().length ? `<span class="tab-badge" aria-label="${expiringSoon().length} expiring soon">${expiringSoon().length}</span>` : ''}
      <span class="ico" aria-hidden="true">${t.ico}</span>${t.label}</button>`).join('')}</nav>
    <main>${body()}</main>`;
  if (draft && $('#groceryAdd')) {
    for (const [k, v] of Object.entries(draft)) $('#groceryAdd').elements[k].value = v;
    if (active) $('#groceryAdd').elements[active].focus();
  }
  window.scrollTo(0, scroll);
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    S.tab = tab.dataset.tab;
    store.set('tab', S.tab);
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  e.preventDefault();
  Promise.resolve(ACTIONS[el.dataset.action](el.dataset.id, el)).catch((ex) => toast(ex.message));
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-action]')) { e.preventDefault(); e.target.click(); }
});

const ACTIONS = {};

ACTIONS.settings = () => openForm({
  title: 'Settings',
  meta: `<p style="margin:-4px 0 14px"><button type="button" class="btn" data-action="openImport">📥 Import cat records…</button></p>`,
  fields: [{ name: 'currency', label: 'Currency symbol', value: S.db.settings.currency, required: true, placeholder: 'e.g. $, RM, £, €' }],
  onSubmit: (v) => saveSettings({ currency: v.currency.trim().slice(0, 6) || '$' }, 'Settings saved'),
  onDelete: () => signOut(auth),
  deleteLabel: 'Sign out',
  confirmDelete: false,
});

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

ACTIONS.openImport = () => {
  const modal = $('#modal');
  if (modal.open) modal.close();
  modal.innerHTML = `<form id="importForm">
    <h3>📥 Import cat records</h3>
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
};

// ============================================================
// Home: the overview of everything
// ============================================================
function renderHome() {
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const catById = Object.fromEntries(S.db.cats.map((c) => [c.id, c]));
  const due = dueList().filter((x) => catById[x.e.catId]).slice(0, 5);
  const toBuy = S.db.groceries.filter((g) => !g.bought)
    .sort((a, b) => b.addedDate.localeCompare(a.addedDate) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const expiring = expiringSoon();
  const more = (tab) => `<button class="btn ghost small" data-tab="${tab}">See all ›</button>`;

  const catsCard = `<div class="card">
    <div class="section-head"><h2>🐾 Cats · next up</h2>${more('cats')}</div>
    ${!S.db.cats.length ? '<p class="empty">No cats yet.</p>'
      : due.length ? due.map(({ e, due: d, planned }) => `<div class="reminder clickable" role="button" tabindex="0" data-action="openCat" data-id="${e.catId}">
          ${avatar(catById[e.catId])}
          <div class="grow"><div><strong>${esc(catById[e.catId].name)}</strong> · ${EVENT_ICONS[e.type] || '📌'} ${esc(e.type)}</div>
          <div class="meta muted small">${planned ? 'Planned' : `Last ${fmtShort(e.date)}`}${e.notes ? ' · ' + esc(shorten(e.notes, 60)) : ''}</div></div>
          ${dueBadge(d)}</div>`).join('')
      : '<p class="empty">Nothing scheduled. Add a "next due" date to a vaccine, deworm or vet visit.</p>'}
  </div>`;

  const moneyCard = `<div class="card">
    <div class="section-head"><h2>💰 ${fmtMonth(thisMonth())}</h2>${more('money')}</div>
    ${people().map((p) => personBalance(p, thisMonth())).join('')}
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
        <div class="grow"><div class="title">${esc(g.name)}${g.quantity ? ` <span class="muted">· ${esc(g.quantity)}</span>` : ''}</div>
        <div class="meta">Out since ${fmtShort(g.addedDate)}${g.createdBy ? ` · ${esc(g.createdBy)}` : ''}</div></div></li>`).join('')}</ul>
      ${toBuy.length > shown.length ? `<p class="small muted" style="margin:8px 0 0">and ${toBuy.length - shown.length} more…</p>` : ''}`
      : '<p class="empty">Nothing to buy. 🎉</p>'}
  </div>`;

  return `<div class="home-hello"><h2>${hello}, ${esc(S.me)}</h2>
      <p class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
    ${expiringCard}${catsCard}${moneyCard}${groceryCard}`;
}

ACTIONS.openCat = (id) => {
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

ACTIONS.activity = () => {
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
};

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
  const items = [...latest.values()].filter((e) => e.nextDue).map((e) => ({ e, due: e.nextDue, planned: false }));
  for (const e of S.db.events) if (e.date > t) items.push({ e, due: e.date, planned: true });
  return items.sort((a, b) => a.due.localeCompare(b.due));
}
const upcomingReminders = () => dueList().filter((x) => daysUntil(x.due) <= 30);

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
      ${reminders.filter((r) => catById[r.e.catId]).slice(0, S.showAllReminders ? undefined : 5).map(({ e, due, planned }) => `<div class="reminder">${avatar(catById[e.catId])}
        <div class="grow"><div><strong>${esc(catById[e.catId].name)}</strong> · ${esc(e.type)}</div>
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
    ['Age', age(cat.birthday)], ['Birthday', fmtDate(cat.birthday)], ['Sex', cat.sex], ['Breed', cat.breed],
    ['Colour', cat.color], ['Microchip', cat.microchip], ['Weight', latestW ? fmtKg(latestW.kg) : ''],
  ].filter(([, v]) => v);

  const profile = `<div class="card">
    <div class="profile">${avatar(cat, 'lg')}
      <div class="grow"><h2>${esc(cat.name)}</h2>
        <div class="muted small">${esc([cat.breed, age(cat.birthday)].filter(Boolean).join(' · ')) || 'Add details in the profile'}</div></div>
      <button class="btn" data-action="editCat" data-id="${cat.id}">Edit</button></div>
    ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>` : ''}
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
        <div><dt>Next up</dt><dd>${due ? `${esc(due.e.type)} ${dueBadge(due.due)}` : '<span class="muted">Nothing scheduled</span>'}</dd></div>
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
      { name: 'birthday', label: 'Birthday (or estimate)', type: 'date', value: cat?.birthday },
      { name: 'color', label: 'Colour / markings', value: cat?.color },
      { name: 'microchip', label: 'Microchip no.', value: cat?.microchip },
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
      { name: 'nextDue', label: 'Next due (optional)', type: 'date', value: ev?.nextDue },
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
const EXPENSE_CATS = ['Groceries', 'Rent / Mortgage', 'Utilities', 'Transport', 'Dining out', 'Pets', 'Health', 'Shopping',
  'Entertainment', 'Bills & subscriptions', 'Savings', 'Gifts', 'Other'];
const INCOME_CATS = ['Salary', 'Bonus', 'Side income', 'Refund', 'Other'];

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

function monthTotals(month, who) {
  const tx = S.db.transactions.filter((t) => t.month === month && (who === 'all' || personOf(t) === who));
  const sum = (type) => tx.filter((t) => t.type === type).reduce((n, t) => n + t.amount, 0);
  const inc = sum('income'), exp = sum('expense');
  return { tx, inc, exp, left: inc - exp };
}

function renderMoney() {
  const who = moneyWho();
  const { tx, inc, exp, left } = monthTotals(S.month, who);
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');
  const income = tx.filter((t) => t.type === 'income').sort(byDate);
  const expenses = tx.filter((t) => t.type === 'expense').sort(byDate);
  const pct = inc > 0 ? Math.min(100, (exp / inc) * 100) : (exp > 0 ? 100 : 0);

  const cats = {};
  for (const t of expenses) cats[t.category || 'Other'] = (cats[t.category || 'Other'] || 0) + t.amount;
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  const txItem = (t) => `<li class="clickable" data-action="editTx" data-id="${t.id}">
    ${who === 'all' ? personDot(personOf(t)) : ''}
    <div class="grow"><div class="title">${esc(t.description || t.category || (t.type === 'income' ? 'Income' : 'Expense'))}</div>
    <div class="meta">${[who === 'all' ? personOf(t) : '', t.description ? t.category : '', fmtShort(t.date)].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="meta">${byline(t)}</div></div>
    <span class="amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span></li>`;

  const prevIncome = S.db.transactions.filter((t) => t.month === shiftMonth(S.month, -1) && t.type === 'income' && (who === 'all' || personOf(t) === who));
  const tabs = [...people(), 'all'];
  const whose = who === 'all' ? 'Both of you' : who === S.me ? 'Your' : `${who}'s`;

  return `
    <div class="seg money-tabs" role="tablist">${tabs.map((p) => `<button role="tab" data-action="moneyWho" data-id="${esc(p)}"
      aria-selected="${p === who}">${p === 'all' ? '👫 Both' : `${personDot(p)}${esc(whoLabel(p))}`}</button>`).join('')}</div>
    <div class="month-nav">
      <button class="btn icon" data-action="month" data-id="-1" aria-label="Previous month">‹</button>
      <h2>${fmtMonth(S.month)}</h2>
      <button class="btn icon" data-action="month" data-id="1" aria-label="Next month">›</button>
      ${S.month !== thisMonth() ? `<button class="btn ghost small" data-action="month" data-id="0">Today</button>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><span>Income</span><strong class="amount income">${money(inc)}</strong></div>
      <div class="stat"><span>Spent</span><strong class="amount expense">${money(exp)}</strong></div>
      <div class="stat"><span>${left < 0 ? 'Over by' : 'Left'}</span><strong class="amount" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${money(Math.abs(left))}</strong></div>
    </div>
    ${who === 'all' ? `<div class="card"><div class="section-head"><h2>Each of you</h2></div>${people().map((p) => personBalance(p, S.month)).join('')}</div>` : ''}
    <div class="card">
      <div class="row"><span class="grow small muted">${inc > 0 ? `${whose === 'Your' ? 'You have' : whose === 'Both of you' ? 'Together you have' : `${esc(who)} has`} spent ${Math.round((exp / inc) * 100)}% of income` : 'Add this month\'s income to see the balance'}</span></div>
      <div class="meter ${exp > inc && inc > 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn primary" data-action="addTx" data-id="expense">＋ Spending</button>
        <button class="btn" data-action="addTx" data-id="income">＋ Income</button>
        ${!tx.some((t) => t.type === 'income') && prevIncome.length
          ? `<button class="btn ghost" data-action="copyIncome">Copy last month's income</button>` : ''}
      </div>
    </div>
    ${catRows.length ? `<div class="card"><div class="section-head"><h2>Where it went</h2></div><div class="bars">
      ${catRows.map(([c, v]) => `<div class="bar-row"><span>${esc(c)}</span><div class="meter"><div style="width:${(v / maxCat) * 100}%"></div></div>
        <span class="amount">${money(v)}</span></div>`).join('')}</div></div>` : ''}
    <div class="card"><div class="section-head"><h2>Income<small>${income.length}</small></h2></div>
      ${income.length ? `<ul class="list">${income.map(txItem).join('')}</ul>` : '<p class="empty">No income added for this month.</p>'}</div>
    <div class="card"><div class="section-head"><h2>Spending<small>${expenses.length}</small></h2></div>
      ${expenses.length ? `<ul class="list">${expenses.map(txItem).join('')}</ul>` : '<p class="empty">No spending recorded yet.</p>'}</div>`;
}

// One person's month at a glance (used on Home and in the Both tab).
function personBalance(p, month) {
  const { inc, exp, left } = monthTotals(month, p);
  const pct = inc > 0 ? Math.min(100, (exp / inc) * 100) : (exp > 0 ? 100 : 0);
  return `<div class="balance clickable" role="button" tabindex="0" data-action="openMoney" data-id="${esc(p)}">
    <div class="row">${personDot(p)}<strong class="grow">${esc(p === S.me ? `${p} (you)` : p)}</strong>
      <span class="amount" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${left < 0 ? 'Over ' : ''}${money(Math.abs(left))}${left < 0 ? '' : ' left'}</span></div>
    <div class="meter ${exp > inc && inc > 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
    <div class="meta">Income ${money(inc)} · Spent ${money(exp)}</div>
  </div>`;
}

ACTIONS.moneyWho = (p) => { S.moneyWho = p === S.me ? 'me' : p; store.set('moneyWho', S.moneyWho); render(); };
ACTIONS.openMoney = (p) => {
  S.tab = 'money'; store.set('tab', 'money');
  S.month = thisMonth();
  ACTIONS.moneyWho(p);
  window.scrollTo(0, 0);
};

ACTIONS.month = (n) => { S.month = Number(n) === 0 ? thisMonth() : shiftMonth(S.month, Number(n)); render(); };

ACTIONS.copyIncome = async () => {
  const who = moneyWho();
  const prev = S.db.transactions.filter((t) => t.month === shiftMonth(S.month, -1) && t.type === 'income' && (who === 'all' || personOf(t) === who));
  for (const t of prev) {
    save('transactions', null, {
      type: 'income', amount: t.amount, month: S.month, category: t.category, description: t.description, person: personOf(t),
      date: S.month === thisMonth() ? today() : S.month + '-01',
    });
  }
  toast(`Copied ${prev.length} income item${prev.length === 1 ? '' : 's'}`);
};

function txForm(t, type) {
  type = t?.type || type;
  const defaultDate = S.month === thisMonth() ? today() : S.month + '-01';
  const cats = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  openForm({
    title: `${t ? 'Edit' : 'Add'} ${type === 'income' ? 'income' : 'spending'}`,
    meta: history(t),
    fields: [
      { name: 'type', type: 'segment', label: 'Type', value: type, options: [{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }] },
      { name: 'person', type: 'segment', label: 'Whose', value: t ? personOf(t) : (moneyWho() === 'all' ? S.me : moneyWho()),
        options: people().map((p) => ({ value: p, label: p === S.me ? `Mine (${p})` : `${p}'s` })) },
      { name: 'amount', label: `Amount (${S.db.settings.currency})`, type: 'number', step: '0.01', min: 0, required: true, value: t?.amount },
      { name: 'description', label: 'Description', value: t?.description, placeholder: type === 'income' ? 'e.g. My salary' : 'e.g. Electricity bill' },
      { name: 'category', label: 'Category', type: 'select', options: t?.category && !cats.includes(t.category) ? [...cats, t.category] : cats, value: t?.category || cats[0] },
      { name: 'date', label: 'Date', type: 'date', value: t?.date || defaultDate },
    ],
    onSubmit: (v) => {
      v.month = v.date ? v.date.slice(0, 7) : (t?.month || S.month);
      const who = moneyWho();
      const msg = v.month !== S.month ? `Saved to ${fmtMonth(v.month)}`
        : who !== 'all' && v.person && v.person !== who ? `Saved to ${v.person === S.me ? 'your' : `${v.person}'s`} tab` : 'Saved';
      return t ? save('transactions', t.id, v, msg) : save('transactions', null, v, msg);
    },
    onDelete: t ? () => remove('transactions', t.id, 'Deleted') : null,
  });
  // Swap category options when switching between spending and income.
  const modal = $('#modal');
  modal.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => {
    const list = r.value === 'income' ? INCOME_CATS : EXPENSE_CATS;
    $('select[name=category]', modal).innerHTML = list.map((c) => `<option>${esc(c)}</option>`).join('');
    $('h3', modal).textContent = `${t ? 'Edit' : 'Add'} ${r.value === 'income' ? 'income' : 'spending'}`;
  }));
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

function renderGrocery() {
  const items = S.db.groceries;
  const needed = items.filter((g) => !g.bought)
    .sort((a, b) => b.addedDate.localeCompare(a.addedDate) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  // In stock: soonest expiry first, then items without an expiry date (newest purchase first).
  const inStock = items.filter((g) => g.bought).sort((a, b) =>
    (a.expiry ? 0 : 1) - (b.expiry ? 0 : 1) || (a.expiry || '').localeCompare(b.expiry || '')
    || (b.boughtDate || '').localeCompare(a.boughtDate || ''));
  const expiring = expiringSoon();
  const qty = (g) => (g.quantity ? ` <span class="muted">· ${esc(g.quantity)}</span>` : '');

  const neededItem = (g) => `<li>
    <button class="check" data-action="toggleGrocery" data-id="${g.id}" aria-label="Mark ${esc(g.name)} as bought">✓</button>
    <div class="grow clickable" data-action="editGrocery" data-id="${g.id}" style="cursor:pointer">
      <div class="title">${esc(g.name)}${qty(g)}</div>
      <div class="meta">Out since ${fmtDate(g.addedDate)}${g.note ? ' · ' + esc(g.note) : ''}</div>
      <div class="meta">${byline(g)}</div>
    </div></li>`;

  const stockItem = (g) => {
    const buyer = g.boughtBy || g.updatedBy || g.createdBy;
    return `<li>
    <button class="check on" data-action="toggleGrocery" data-id="${g.id}" aria-label="${esc(g.name)} ran out: put back on the shopping list" title="Ran out? Put back on the list">✓</button>
    <div class="grow clickable" data-action="editGrocery" data-id="${g.id}" style="cursor:pointer">
      <div class="title">${esc(g.name)}${qty(g)}</div>
      <div class="meta">Bought ${fmtDate(g.boughtDate)}${g.note ? ' · ' + esc(g.note) : ''}</div>
      ${buyer ? `<div class="meta"><span class="by">${personDot(buyer)}Bought by ${esc(buyer)}</span></div>` : ''}
    </div>
    ${g.expiry ? expiryBadge(g.expiry) : `<button class="btn ghost small" data-action="addExpiry" data-id="${g.id}">＋ Expiry</button>`}
    </li>`;
  };

  return `
    ${expiring.length ? `<div class="card alert">
      <div class="section-head"><h2>⚠️ Expiring soon<small>${expiring.length}</small></h2></div>
      <ul class="list">${expiring.map((g) => `<li class="clickable" data-action="editGrocery" data-id="${g.id}">
        <div class="grow"><div class="title">${esc(g.name)}${qty(g)}</div>
        <div class="meta">Expiry ${fmtDate(g.expiry)}</div></div>${expiryBadge(g.expiry)}</li>`).join('')}</ul>
      <p class="small muted" style="margin:8px 0 0">Tap an item to change it, or remove it once it's used up or thrown away.</p>
    </div>` : ''}
    <div class="card">
      <form class="quick-add" id="groceryAdd">
        <input name="name" placeholder="What ran out? e.g. Milk" required autocomplete="off" list="groceryHistory">
        <input name="quantity" class="qty" placeholder="Qty" autocomplete="off">
        <button class="btn primary" type="submit">Add</button>
        <datalist id="groceryHistory">${[...new Set(items.map((g) => g.name))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </form>
      <p class="small muted" style="margin:8px 0 0">Today's date (${fmtDate(today())}) is saved automatically. Tick an item when it's bought.</p>
    </div>
    <div class="card">
      <div class="section-head"><h2>🛒 Out of stock<small>${needed.length}</small></h2></div>
      ${needed.length ? `<ul class="list">${needed.map(neededItem).join('')}</ul>` : '<p class="empty">Nothing needed. The pantry is stocked! 🎉</p>'}
    </div>
    <div class="card">
      <div class="section-head"><h2>🏠 In stock<small>${inStock.length}</small></h2>
        <button class="btn primary" data-action="addStock">＋ Add</button></div>
      ${inStock.length ? `<ul class="list">${inStock.map(stockItem).join('')}</ul>
        <p class="small muted" style="margin:8px 0 0">Ran out? Tap the tick to put it back on the shopping list.</p>`
        : '<p class="empty">Items you tick as bought land here. Add an expiry date and you\'ll be warned the day before.</p>'}
    </div>`;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'groceryAdd') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target).entries());
  if (!v.name.trim()) return;
  const existing = S.db.groceries.find((g) => !g.bought && g.name.toLowerCase() === v.name.trim().toLowerCase());
  if (existing) { toast(`${existing.name} is already on the list`); return; }
  try {
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
    { name: 'expiry', label: 'Expiry date (optional)', type: 'date' },
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
        { name: 'expiry', label: 'Expiry date (optional)', type: 'date', value: g.expiry },
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
