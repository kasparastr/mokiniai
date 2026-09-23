const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function money(n) { return '€' + Number(n || 0).toFixed(2); }
function value(l) { return Number(l.effectiveAmount != null ? l.effectiveAmount : l.amount) || 0; }
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDay(iso) {
  return parseISO(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function payChip(l) {
  if (l.viaPrepay) return '<span class="chip prepaid">Prepaid</span>';
  if (l.paidCash) return '<span class="chip paid">Paid</span>';
  if (l.status === 'cancelled') return '';
  if (l.status === 'scheduled') return '<span class="chip due">Due</span>';
  return '<span class="chip unpaid">Unpaid</span>';
}

let state = null;

async function boot() {
  const res = await fetch('/portal/state');
  if (!res.ok) {
    document.getElementById('login').hidden = false;
    document.getElementById('app').hidden = true;
    return;
  }
  state = await res.json();
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  render();
}

async function doLogin() {
  const username = document.getElementById('u').value.trim();
  const password = document.getElementById('p').value;
  const msg = document.getElementById('loginMsg');
  msg.textContent = '';
  try {
    const res = await fetch('/portal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    boot();
  } catch (e) {
    msg.textContent = e.message;
  }
}

async function doLogout() {
  await fetch('/portal/logout', { method: 'POST' });
  location.reload();
}

async function submitRequest() {
  const ta = document.getElementById('reqText');
  const btn = document.getElementById('reqBtn');
  const msg = document.getElementById('reqMsg');
  const message = ta.value.trim();
  if (!message) return;
  btn.disabled = true;
  try {
    const res = await fetch('/portal/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');
    ta.value = '';
    msg.textContent = 'Sent.';
    await boot();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function render() {
  const { student, lessons, requests, availability } = state;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = lessons.filter(l => parseISO(l.date) >= today && l.status !== 'cancelled')
    .sort((a, b) => a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date));
  const past = lessons.filter(l => parseISO(l.date) < today || l.status === 'cancelled')
    .sort((a, b) => a.date === b.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date))
    .slice(0, 8);

  const balance = student.prepaidBalance;
  const offDays = availability.excludedWeekdays.map(w => WEEKDAYS[w]).join(' and ');

  document.getElementById('app').innerHTML = `
    <div class="hdr">
      <div>
        <h1>${student.name}</h1>
        <span>${student.subject}${student.grade ? ' · ' + student.grade : ''}</span>
      </div>
      <button class="logout" onclick="doLogout()">Sign out</button>
    </div>

    <div class="card">
      <span class="lbl">Prepaid credits</span>
      <div class="big">${balance > 0 ? balance + ' left' : 'None'}</div>
    </div>

    <div class="sec-h">Upcoming lessons</div>
    <div class="card">
      ${upcoming.length ? upcoming.map(l => `
        <div class="row">
          <div class="row-d">${fmtDay(l.date)}</div>
          <div class="row-b">
            <div class="row-t">${l.time} · ${escapeHtml(l.subject)}</div>
          </div>
          ${payChip(l)}
        </div>`).join('') : '<div class="empty">Nothing scheduled yet.</div>'}
    </div>

    <div class="sec-h">Lesson availability</div>
    <div class="card">
      <p class="note" style="margin:0;">Lessons generally happen every day except ${offDays}, between ${availability.startTime} and ${availability.endTime}. Want a different time? Ask below.</p>
    </div>

    <div class="sec-h">Ask for a different time (or anything else)</div>
    <div class="card">
      <textarea id="reqText" placeholder="e.g. Could we move Thursday's lesson to 18:00 instead?"></textarea>
      <button id="reqBtn" class="pri" onclick="submitRequest()">Send</button>
      <div id="reqMsg" class="note"></div>
      ${requests.length ? `<div style="margin-top:14px; border-top:1px solid var(--line-2); padding-top:8px;">
        ${requests.map(r => `<div class="row"><div class="row-b"><div class="row-t">${escapeHtml(r.message)}</div><div class="row-s">${r.createdAt}</div></div></div>`).join('')}
      </div>` : ''}
    </div>

    <div class="sec-h">Past lessons</div>
    <div class="card">
      ${past.length ? past.map(l => `
        <div class="row">
          <div class="row-d">${fmtDay(l.date)}</div>
          <div class="row-b">
            <div class="row-t">${l.time} · ${escapeHtml(l.subject)}</div>
            <div class="row-s">${l.status === 'cancelled' ? 'Cancelled' : money(value(l))}</div>
          </div>
          ${payChip(l)}
        </div>`).join('') : '<div class="empty">No lessons yet.</div>'}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
