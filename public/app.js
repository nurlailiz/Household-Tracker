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
  let h = 0; for (const c of cat.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${cls}" style="background:${CAT_COLORS[h % CAT_COLORS.length]}">${esc(cat.name[0]?.toUpperCase() || '?')}</span>`;
}

function dueBadge(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0) return `<span class="badge danger">Overdue ${-d}d</span>`;
  if (d === 0) return `<span class="badge danger">Due today</span>`;
  if (d <= 14) return `<span class="badge warn">In ${d} day${d === 1 ? '' : 's'}</span>`;
  return `<span class="badge">${fmtDate(dateStr)}</span>`;
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
  tab: store.get('tab', 'cats'),
  catId: store.get('catId', null),
  month: thisMonth(),
};

// Field types per collection: used to clean form values before saving.
const SCHEMA = {
  cats: { name: 'str!', breed: 'str', sex: 'str', birthday: 'str', color: 'str', microchip: 'str', notes: 'str', photo: 'str' },
  weights: { catId: 'str!', date: 'str!', kg: 'num!', notes: 'str' },
  feedings: { catId: 'str!', time: 'str!', food: 'str', amount: 'str', notes: 'str' },
  events: { catId: 'str!', type: 'str!', date: 'str!', nextDue: 'str', notes: 'str' },
  transactions: { type: 'str!', amount: 'num!', month: 'str!', date: 'str', category: 'str', description: 'str' },
  groceries: { name: 'str!', quantity: 'str', note: 'str', addedDate: 'str!', bought: 'bool', boughtDate: 'str' },
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
    ready('settings');
  }, onError));
}
function stopSync() { unsubscribers.forEach((u) => u()); unsubscribers = []; }

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
function openForm({ title, fields, submitLabel = 'Save', onSubmit, onDelete, deleteLabel = 'Delete', confirmDelete = true }) {
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
    <img src="/icon.svg" alt="">
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
  { id: 'cats', label: 'Cats', ico: '🐱' },
  { id: 'money', label: 'Money', ico: '💰' },
  { id: 'grocery', label: 'Grocery', ico: '🛒' },
];

function render() {
  if (!S.db) return;
  const scroll = window.scrollY;
  const active = document.activeElement?.closest('#groceryAdd') ? document.activeElement.name : null;
  const draft = $('#groceryAdd') ? Object.fromEntries(new FormData($('#groceryAdd')).entries()) : null;
  const body = { cats: renderCats, money: renderMoney, grocery: renderGrocery }[S.tab] || renderCats;
  $('#app').innerHTML = `
    <header class="topbar">
      <h1><img src="/icon.svg" alt="">Our Home</h1>
      <span class="who">Hi, ${esc(S.me)}</span>
      <button class="btn icon ghost" data-action="settings" title="Settings" aria-label="Settings">⚙️</button>
    </header>
    <nav class="tabs">${TABS.map((t) => `<button data-tab="${t.id}" ${S.tab === t.id ? 'aria-current="page"' : ''}>
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

const ACTIONS = {};

ACTIONS.settings = () => openForm({
  title: 'Settings',
  fields: [{ name: 'currency', label: 'Currency symbol', value: S.db.settings.currency, required: true, placeholder: 'e.g. $, RM, £, €' }],
  onSubmit: (v) => saveSettings({ currency: v.currency.trim().slice(0, 6) || '$' }, 'Settings saved'),
  onDelete: () => signOut(auth),
  deleteLabel: 'Sign out',
  confirmDelete: false,
});

// ============================================================
// Cats
// ============================================================
const EVENT_TYPES = ['Vaccination', 'Deflea', 'Deworm', 'Vet visit', 'Grooming', 'Medication', 'Birthday', 'Other'];
const EVENT_ICONS = { Vaccination: '💉', Deflea: '🪲', Deworm: '💊', 'Vet visit': '🩺', Grooming: '✂️', Medication: '💊', Birthday: '🎂' };

function currentCat() {
  const cats = S.db.cats;
  let cat = cats.find((c) => c.id === S.catId);
  if (!cat && cats.length) { cat = cats[0]; S.catId = cat.id; }
  return cat;
}

function upcomingReminders() {
  // The latest event of each (cat, type) with a next-due date within 30 days (or overdue).
  const latest = new Map();
  for (const e of S.db.events) {
    const key = e.catId + '|' + e.type;
    const prev = latest.get(key);
    if (!prev || e.date > prev.date) latest.set(key, e);
  }
  return [...latest.values()]
    .filter((e) => e.nextDue && daysUntil(e.nextDue) <= 30)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

function renderCats() {
  const cats = S.db.cats;
  const cat = currentCat();
  const chips = `<div class="chips">${cats.map((c) => `<button class="chip" data-action="pickCat" data-id="${c.id}" aria-pressed="${c.id === cat?.id}">
      ${avatar(c)}${esc(c.name)}</button>`).join('')}
    <button class="chip add" data-action="addCat">＋ Add cat</button></div>`;

  if (!cat) {
    return chips + `<div class="card empty"><p style="font-size:2.5rem;margin:0">🐾</p>
      <p>No cats yet. Add your first cat to start tracking weight, feeding and vet dates.</p>
      <button class="btn primary" data-action="addCat">Add a cat</button></div>`;
  }

  const reminders = upcomingReminders();
  const catById = Object.fromEntries(cats.map((c) => [c.id, c]));
  const remindersHtml = reminders.length ? `<div class="card">
      <div class="section-head"><h2>⏰ Coming up</h2></div>
      ${reminders.map((e) => `<div class="reminder">${avatar(catById[e.catId])}
        <div class="grow"><div><strong>${esc(catById[e.catId].name)}</strong> · ${esc(e.type)}</div>
        <div class="meta muted small">Last done ${fmtDate(e.date)}</div></div>${dueBadge(e.nextDue)}</div>`).join('')}
    </div>` : '';

  const weights = S.db.weights.filter((w) => w.catId === cat.id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const latestW = weights[weights.length - 1];
  const feedings = S.db.feedings.filter((f) => f.catId === cat.id).sort((a, b) => a.time.localeCompare(b.time));
  const events = S.db.events.filter((e) => e.catId === cat.id).sort((a, b) => b.date.localeCompare(a.date));

  const facts = [
    ['Age', age(cat.birthday)], ['Birthday', fmtDate(cat.birthday)], ['Sex', cat.sex], ['Breed', cat.breed],
    ['Colour', cat.color], ['Microchip', cat.microchip], ['Weight', latestW ? `${latestW.kg} kg` : ''],
  ].filter(([, v]) => v);

  const profile = `<div class="card">
    <div class="profile">${avatar(cat, 'lg')}
      <div class="grow"><h2>${esc(cat.name)}</h2>
        <div class="muted small">${esc([cat.breed, age(cat.birthday)].filter(Boolean).join(' · ')) || 'Add details in the profile'}</div></div>
      <button class="btn" data-action="editCat" data-id="${cat.id}">Edit</button></div>
    ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>` : ''}
    ${cat.notes ? `<p class="notes">${esc(cat.notes)}</p>` : ''}
  </div>`;

  const weightCard = `<div class="card">
    <div class="section-head"><h2>⚖️ Weight</h2><button class="btn primary" data-action="addWeight">＋ Log weight</button></div>
    ${weights.length >= 2 ? weightChart(weights) : ''}
    ${weights.length ? `<ul class="list">${weights.slice().reverse().slice(0, S.showAllWeights ? undefined : 6).map((w) => {
      const i = weights.indexOf(w), prev = weights[i - 1];
      const diff = prev ? Math.round((w.kg - prev.kg) * 100) / 100 : null;
      return `<li class="clickable" data-action="editWeight" data-id="${w.id}">
        <div class="grow"><div class="title">${w.kg} kg</div><div class="meta">${fmtDate(w.date)}${w.notes ? ' · ' + esc(w.notes) : ''}</div></div>
        ${diff !== null && diff !== 0 ? `<span class="badge">${diff > 0 ? '▲ +' : '▼ '}${diff} kg</span>` : ''}</li>`;
    }).join('')}</ul>
    ${weights.length > 6 ? `<button class="btn ghost" data-action="toggleWeights">${S.showAllWeights ? 'Show less' : `Show all ${weights.length}`}</button>` : ''}`
    : `<p class="empty">No weigh-ins yet.</p>`}
  </div>`;

  const feedingCard = `<div class="card">
    <div class="section-head"><h2>🍽️ Feeding schedule</h2><button class="btn primary" data-action="addFeeding">＋ Add meal</button></div>
    ${feedings.length ? `<ul class="list">${feedings.map((f) => `<li class="clickable" data-action="editFeeding" data-id="${f.id}">
      <span class="time-pill">${esc(f.time)}</span>
      <div class="grow"><div class="title">${esc(f.food || 'Meal')}${f.amount ? ` <span class="muted">· ${esc(f.amount)}</span>` : ''}</div>
      ${f.notes ? `<div class="meta">${esc(f.notes)}</div>` : ''}</div></li>`).join('')}</ul>`
    : `<p class="empty">No meals scheduled.</p>`}
  </div>`;

  const eventsCard = `<div class="card">
    <div class="section-head"><h2>📅 Important dates</h2><button class="btn primary" data-action="addEvent">＋ Add</button></div>
    ${events.length ? `<ul class="list">${events.map((e) => `<li class="clickable" data-action="editEvent" data-id="${e.id}">
      <span style="font-size:1.4rem" aria-hidden="true">${EVENT_ICONS[e.type] || '📌'}</span>
      <div class="grow"><div class="title">${esc(e.type)}</div>
      <div class="meta">${fmtDate(e.date)}${e.nextDue ? ` · next ${fmtDate(e.nextDue)}` : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
      ${e.nextDue ? dueBadge(e.nextDue) : ''}</li>`).join('')}</ul>`
    : `<p class="empty">Record vaccines, deflea and deworm treatments, vet visits and more. Set a "next due" date to get a reminder.</p>`}
  </div>`;

  return chips + remindersHtml + profile + eventsCard + weightCard + feedingCard;
}

function weightChart(weights) {
  const W = 360, H = 150, P = { l: 30, r: 8, t: 10, b: 20 };
  const pts = weights.slice(-24);
  const xs = pts.map((w) => parseDate(w.date).getTime());
  const ys = pts.map((w) => w.kg);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const padY = Math.max((maxY - minY) * 0.2, 0.2);
  minY = Math.max(0, minY - padY); maxY += padY;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const x = (t) => P.l + (maxX === minX ? 0.5 : (t - minX) / (maxX - minX)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - minY) / (maxY - minY)) * (H - P.t - P.b);
  const line = pts.map((w, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(w.kg).toFixed(1)}`).join('');
  const area = `${line}L${x(xs[xs.length - 1]).toFixed(1)},${H - P.b}L${x(xs[0]).toFixed(1)},${H - P.b}Z`;
  const ticks = [minY, (minY + maxY) / 2, maxY];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time">
    ${ticks.map((t) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${pts.map((w, i) => `<circle class="dot" cx="${x(xs[i])}" cy="${y(w.kg)}" r="3.5"><title>${fmtDate(w.date)}: ${w.kg} kg</title></circle>`).join('')}
    <text x="${P.l}" y="${H - 6}">${fmtShort(pts[0].date)}</text>
    <text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtShort(pts[pts.length - 1].date)}</text>
  </svg>`;
}

ACTIONS.pickCat = (id) => { S.catId = id; store.set('catId', id); render(); };
ACTIONS.toggleWeights = () => { S.showAllWeights = !S.showAllWeights; render(); };

function catForm(cat) {
  openForm({
    title: cat ? `Edit ${cat.name}` : 'Add a cat',
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
  openForm({
    title: w ? 'Edit weight' : `Log weight — ${currentCat().name}`,
    fields: [
      { name: 'kg', label: 'Weight (kg)', type: 'number', step: '0.01', min: 0, required: true, value: w?.kg },
      { name: 'date', label: 'Date', type: 'date', required: true, value: w?.date || today() },
      { name: 'notes', label: 'Notes', value: w?.notes },
    ],
    onSubmit: (v) => w ? save('weights', w.id, v, 'Saved')
      : save('weights', null, { ...v, catId: S.catId }, 'Weight logged'),
    onDelete: w ? () => remove('weights', w.id, 'Deleted') : null,
  });
}
ACTIONS.addWeight = () => weightForm(null);
ACTIONS.editWeight = (id) => weightForm(S.db.weights.find((x) => x.id === id));

function feedingForm(f) {
  const foods = [...new Set(S.db.feedings.map((x) => x.food).filter(Boolean))];
  openForm({
    title: f ? 'Edit meal' : `Add meal — ${currentCat().name}`,
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
    fields: [
      { name: 'type', label: 'What', type: 'select', options: types, required: true, value: ev?.type || 'Vaccination' },
      { name: 'date', label: 'Date done', type: 'date', required: true, value: ev?.date || today() },
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

function renderMoney() {
  const tx = S.db.transactions.filter((t) => t.month === S.month);
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt);
  const income = tx.filter((t) => t.type === 'income').sort(byDate);
  const expenses = tx.filter((t) => t.type === 'expense').sort(byDate);
  const sum = (arr) => arr.reduce((s, t) => s + t.amount, 0);
  const inc = sum(income), exp = sum(expenses), left = inc - exp;
  const pct = inc > 0 ? Math.min(100, (exp / inc) * 100) : (exp > 0 ? 100 : 0);

  const cats = {};
  for (const t of expenses) cats[t.category || 'Other'] = (cats[t.category || 'Other'] || 0) + t.amount;
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const maxCat = catRows[0]?.[1] || 1;

  const txItem = (t) => `<li class="clickable" data-action="editTx" data-id="${t.id}">
    <div class="grow"><div class="title">${esc(t.description || t.category || (t.type === 'income' ? 'Income' : 'Expense'))}</div>
    <div class="meta">${[t.description ? t.category : '', fmtShort(t.date), t.createdBy ? 'by ' + t.createdBy : ''].filter(Boolean).map(esc).join(' · ')}</div></div>
    <span class="amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span></li>`;

  return `
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
    <div class="card">
      <div class="row"><span class="grow small muted">${inc > 0 ? `${Math.round((exp / inc) * 100)}% of income spent` : 'Add this month\'s income to see your budget'}</span></div>
      <div class="meter ${exp > inc && inc > 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn primary" data-action="addTx" data-id="expense">＋ Spending</button>
        <button class="btn" data-action="addTx" data-id="income">＋ Income</button>
        ${!tx.length && S.db.transactions.some((t) => t.month === shiftMonth(S.month, -1) && t.type === 'income')
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

ACTIONS.month = (n) => { S.month = Number(n) === 0 ? thisMonth() : shiftMonth(S.month, Number(n)); render(); };

ACTIONS.copyIncome = async () => {
  const prev = S.db.transactions.filter((t) => t.month === shiftMonth(S.month, -1) && t.type === 'income');
  for (const t of prev) {
    save('transactions', null, {
      type: 'income', amount: t.amount, month: S.month, category: t.category, description: t.description,
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
    fields: [
      { name: 'type', type: 'segment', label: 'Type', value: type, options: [{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }] },
      { name: 'amount', label: `Amount (${S.db.settings.currency})`, type: 'number', step: '0.01', min: 0, required: true, value: t?.amount },
      { name: 'description', label: 'Description', value: t?.description, placeholder: type === 'income' ? 'e.g. My salary' : 'e.g. Electricity bill' },
      { name: 'category', label: 'Category', type: 'select', options: t?.category && !cats.includes(t.category) ? [...cats, t.category] : cats, value: t?.category || cats[0] },
      { name: 'date', label: 'Date', type: 'date', value: t?.date || defaultDate },
    ],
    onSubmit: (v) => {
      v.month = v.date ? v.date.slice(0, 7) : (t?.month || S.month);
      const msg = v.month !== S.month ? `Saved to ${fmtMonth(v.month)}` : 'Saved';
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
function renderGrocery() {
  const items = S.db.groceries;
  const needed = items.filter((g) => !g.bought).sort((a, b) => b.addedDate.localeCompare(a.addedDate) || b.createdAt.localeCompare(a.createdAt));
  const bought = items.filter((g) => g.bought).sort((a, b) => (b.boughtDate || '').localeCompare(a.boughtDate || ''));

  const item = (g) => `<li class="${g.bought ? 'bought' : ''}">
    <button class="check ${g.bought ? 'on' : ''}" data-action="toggleGrocery" data-id="${g.id}" aria-label="${g.bought ? 'Mark as needed' : 'Mark as bought'}">✓</button>
    <div class="grow clickable" data-action="editGrocery" data-id="${g.id}" style="cursor:pointer">
      <div class="title">${esc(g.name)}${g.quantity ? ` <span class="muted">· ${esc(g.quantity)}</span>` : ''}</div>
      <div class="meta">${g.bought ? `Bought ${fmtDate(g.boughtDate)}` : `Out since ${fmtDate(g.addedDate)}`}${g.createdBy ? ' · added by ' + esc(g.createdBy) : ''}${g.note ? ' · ' + esc(g.note) : ''}</div>
    </div></li>`;

  return `
    <div class="card">
      <form class="quick-add" id="groceryAdd">
        <input name="name" placeholder="What ran out? e.g. Milk" required autocomplete="off" list="groceryHistory">
        <input name="quantity" class="qty" placeholder="Qty" autocomplete="off">
        <button class="btn primary" type="submit">Add</button>
        <datalist id="groceryHistory">${[...new Set(items.map((g) => g.name))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </form>
      <p class="small muted" style="margin:8px 0 0">Today's date (${fmtDate(today())}) is saved automatically. Tap an item to edit it.</p>
    </div>
    <div class="card">
      <div class="section-head"><h2>🛒 Out of stock<small>${needed.length}</small></h2></div>
      ${needed.length ? `<ul class="list">${needed.map(item).join('')}</ul>` : '<p class="empty">Nothing needed — the pantry is stocked! 🎉</p>'}
    </div>
    ${bought.length ? `<div class="card">
      <div class="section-head"><h2>Bought<small>${bought.length}</small></h2>
        <button class="btn danger" data-action="clearBought">Clear all</button></div>
      <ul class="list">${bought.slice(0, 30).map(item).join('')}</ul></div>` : ''}`;
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
    ? save('groceries', id, { bought: false, boughtDate: '', addedDate: today() }, `${g.name} back on the list`)
    : save('groceries', id, { bought: true, boughtDate: today() }, `${g.name} bought`);
};

ACTIONS.editGrocery = (id) => {
  const g = S.db.groceries.find((x) => x.id === id);
  openForm({
    title: 'Edit item',
    fields: [
      { name: 'name', label: 'Item', required: true, value: g.name },
      { name: 'quantity', label: 'Quantity', value: g.quantity },
      { name: 'note', label: 'Note', value: g.note, placeholder: 'e.g. brand, store' },
      { name: 'addedDate', label: 'Ran out on', type: 'date', required: true, value: g.addedDate },
    ],
    onSubmit: (v) => save('groceries', id, v, 'Saved'),
    onDelete: () => remove('groceries', id, 'Removed'),
  });
};

ACTIONS.clearBought = async () => {
  const bought = S.db.groceries.filter((g) => g.bought);
  if (!confirm(`Remove ${bought.length} bought item${bought.length === 1 ? '' : 's'}?`)) return;
  const batch = writeBatch(fdb);
  for (const g of bought) batch.delete(doc(fdb, 'groceries', g.id));
  background(batch.commit());
  toast('Cleared');
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
