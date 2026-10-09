const $ = (s) => document.querySelector(s);
const STATUSES = ['new', 'quoted', 'confirmed', 'done', 'cancelled'];
let filter = '', term = '', current = null, stats = {};

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel', ...(opts.headers || {}) } });
  if (r.status === 401 && !path.includes('login')) { showLogin(); throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const fmt = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// <input type=datetime-local> works in local time; stored values are ISO strings
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#pw').focus(); }
async function showApp() { $('#login').hidden = true; $('#app').hidden = false; await refresh(); if (location.hash.length > 1) open(Number(location.hash.slice(1))); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginMsg').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#pw').value }) }); $('#pw').value = ''; showApp(); }
  catch (err) { $('#loginMsg').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
$('#search').addEventListener('input', (e) => { term = e.target.value; loadList(); });

async function refresh() { stats = await api('/api/admin/stats'); renderTabs(); await loadList(); }
function renderTabs() {
  const tabs = $('#tabs'); tabs.replaceChildren();
  for (const s of ['', ...STATUSES]) {
    const n = s ? stats[s] ?? 0 : Object.values(stats).reduce((a, b) => a + b, 0);
    const b = el('button', { className: 'tab', type: 'button', textContent: `${s || 'all'} ${n}` });
    b.setAttribute('aria-pressed', String(filter === s));
    b.addEventListener('click', () => { filter = s; renderTabs(); loadList(); });
    tabs.append(b);
  }
}
async function loadList() {
  const qs = new URLSearchParams(); if (filter) qs.set('status', filter); if (term) qs.set('q', term);
  const rows = await api('/api/admin/leads?' + qs);
  const ul = $('#leads'); ul.replaceChildren();
  if (!rows.length) ul.append(el('li', { className: 'muted', textContent: 'No leads yet.' }));
  for (const r of rows) {
    const b = el('button', { type: 'button' },
      el('span', { className: 'row1' }, el('span', { textContent: r.name }), el('span', { className: 'chip ' + r.status, textContent: r.status })),
      el('span', { className: 'muted', textContent: `${r.town} · ${r.service || 'Quote'}${r.size ? ' · ' + r.size : ''}` }),
      el('span', { className: 'muted', textContent: r.scheduled_start ? 'Scheduled ' + fmt(r.scheduled_start) : fmt(r.created_at) }));
    if (current === r.id) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => open(r.id));
    ul.append(el('li', {}, b));
  }
}
async function open(id) {
  if (!id) return;
  try { current = id; history.replaceState(null, '', '#' + id); render(await api('/api/admin/leads/' + id)); loadList(); }
  catch (e) { $('#detail').replaceChildren(el('p', { className: 'muted pad', textContent: e.message })); }
  document.querySelector('.layout').classList.add('viewing');
}
function field(label, name, value, type = 'text') {
  const i = el('input', { name, type, value: value ?? '' });
  return el('label', {}, label, i);
}
function render(l) {
  const d = $('#detail'); d.replaceChildren();
  const back = el('button', { className: 'btn ghost back', type: 'button', textContent: 'Back to list' });
  back.addEventListener('click', () => document.querySelector('.layout').classList.remove('viewing'));
  const phone = l.phone.replace(/[^\d+]/g, '');
  const acts = el('div', { className: 'acts' },
    el('a', { className: 'btn primary', href: 'tel:' + phone, textContent: 'Call' }),
    el('a', { className: 'btn', href: 'sms:' + phone, textContent: 'Text' }));
  if (l.email) acts.append(el('a', { className: 'btn', href: 'mailto:' + l.email, textContent: 'Email' }));
  const sel = el('select', { name: 'status' }, ...STATUSES.map((s) => el('option', { value: s, textContent: s, selected: s === l.status })));
  const form = el('form', { className: 'grid2' },
    el('label', {}, 'Status', sel),
    field('Quoted price ($)', 'price', l.price, 'number'),
    field('Name', 'name', l.name), field('Phone', 'phone', l.phone, 'tel'),
    field('Email', 'email', l.email, 'email'), field('Town', 'town', l.town),
    field('Service', 'service', l.service), field('TV size', 'size', l.size),
    field('Job address', 'address', l.address),
    field('Start', 'scheduled_start', toLocalInput(l.scheduled_start), 'datetime-local'),
    field('End', 'scheduled_end', toLocalInput(l.scheduled_end), 'datetime-local'));
  const save = el('button', { className: 'btn primary', type: 'submit', textContent: 'Save changes' });
  const toast = el('span', { className: 'toast' });
  form.append(el('div', { className: 'acts', style: 'grid-column:1/-1' }, save, toast));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); save.disabled = true; toast.textContent = '';
    const f = Object.fromEntries(new FormData(form).entries());
    f.scheduled_start = fromLocalInput(f.scheduled_start); f.scheduled_end = fromLocalInput(f.scheduled_end);
    try { render(await api('/api/admin/leads/' + l.id, { method: 'PATCH', body: JSON.stringify(f) })); $('#detail .toast').textContent = 'Saved'; refresh(); }
    catch (err) { toast.textContent = err.message; toast.style.color = 'var(--err)'; save.disabled = false; }
  });
  const note = el('textarea', { rows: 2, placeholder: 'Add a note' });
  const addNote = el('button', { className: 'btn', type: 'button', textContent: 'Add note' });
  addNote.addEventListener('click', async () => {
    if (!note.value.trim()) return;
    await api(`/api/admin/leads/${l.id}/notes`, { method: 'POST', body: JSON.stringify({ body: note.value }) });
    render(await api('/api/admin/leads/' + l.id));
  });
  const tl = el('ul', { className: 'tl' }, ...l.events.slice().reverse().map((ev) =>
    el('li', {}, el('time', { textContent: `${fmt(ev.at)} · ${ev.kind}` }), ev.body)));
  d.append(back, el('h2', { textContent: `#${l.id} ${l.name}` }), el('div', { className: 'muted', textContent: 'Received ' + fmt(l.created_at) }), acts);
  if (l.message) d.append(el('div', { className: 'msgbox', textContent: l.message }));
  d.append(form, el('h3', { textContent: 'Notes and history' }), note, addNote, tl);
}

api('/api/session').then(showApp).catch(showLogin);
