// ---------- Constants ----------
const SUBJECTS = ['Mathematics', 'Economics', 'Other'];
const COLORS = ['#2F6B4F', '#8B4A2B', '#3B5A6B', '#7A5C2E', '#6B3F5C', '#4A6B3F', '#8B3A3A', '#3F5C6B'];
const STATUS_LABELS = { scheduled: 'Scheduled', completed: 'Done', cancelled: 'Cancelled' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- State ----------
let state = {
  students: [],
  lessons: [],
  payments: [],
  tab: 'overview',
  loaded: false,
  busy: false,
  error: null,
  calendarMonth: new Date(),
  selectedDate: todayISO(),
  filterStatus: 'all',
  filterPaid: 'all',
  filterStudent: 'all',
};
let lessonModal = null;
let studentModal = null;
let confirmModal = null;
let prepayForm = null;

// ---------- Date helpers ----------
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() { return toISO(new Date()); }
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDay(iso) {
  return parseISO(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtDayLong(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === toISO(tomorrow)) return 'Tomorrow';
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (iso === toISO(yesterday)) return 'Yesterday';
  return parseISO(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
function fmtMonth(d) { return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
function monthGrid(monthDate) {
  const y = monthDate.getFullYear(), m = monthDate.getMonth();
  const start = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < start; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d));
  while (cells.length % 7) cells.push(null);
  return cells;
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function money(n) { return '€' + Number(n || 0).toFixed(2); }

// ---------- API ----------
async function call(path, options) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}
// Every mutation returns full state, so applying is uniform.
async function mutate(path, options) {
  state.busy = true; state.error = null; render();
  try {
    const data = await call(path, options);
    state.students = data.students;
    state.lessons = data.lessons;
    state.payments = data.payments;
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  render();
}

// ---------- Lookups ----------
function studentById(id) { return state.students.find(s => s.id === id) || null; }
function lessonById(id) { return state.lessons.find(l => l.id === id) || null; }
function lessonsFor(date) {
  return state.lessons.filter(l => l.date === date).sort((a, b) => a.time.localeCompare(b.time));
}
function paymentsFor(studentId) {
  return state.payments.filter(p => p.studentId === studentId);
}

// ---------- Derived ----------
function monthStats() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let received = 0, owed = 0, done = 0, upcoming = 0;
  const today = todayISO();
  state.lessons.forEach(l => {
    const inMonth = l.date.startsWith(ym);
    if (l.paidCash && inMonth) received += l.amount;
    if (l.status === 'completed' && !l.paid) owed += l.amount;
    if (l.status === 'completed' && inMonth) done += 1;
    if (l.status === 'scheduled' && l.date >= today) upcoming += 1;
  });
  state.payments.forEach(p => { if (p.date.startsWith(ym)) received += p.amount; });
  const credits = state.students.reduce((s, x) => s + Math.max(0, x.prepaidBalance), 0);
  return { received, owed, done, upcoming, credits };
}
function unpaidLessons() {
  return state.lessons
    .filter(l => l.status === 'completed' && !l.paid)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
function stalePast() {
  const today = todayISO();
  return state.lessons.filter(l => l.status === 'scheduled' && l.date < today);
}
function nextLessons(n) {
  const today = todayISO();
  const now = new Date().toTimeString().slice(0, 5);
  return state.lessons
    .filter(l => l.status === 'scheduled')
    .filter(l => l.date > today || (l.date === today && l.time >= now))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, n);
}

// ---------- Icons ----------
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
};
function icon(name, cls) { return `<span class="icn ${cls || ''}">${I[name]}</span>`; }

// ---------- Render ----------
function render() {
  const root = document.getElementById('app');
  if (!state.loaded) {
    root.innerHTML = '<div class="boot">Loading…</div>';
    return;
  }
  root.innerHTML = `
    ${header()}
    <main>${tabContent()}</main>
    ${state.tab === 'students'
      ? `<button class="fab" data-a="new-student" aria-label="Add student">${I.plus}</button>`
      : `<button class="fab" data-a="new-lesson" aria-label="Add lesson">${I.plus}</button>`}
    ${nav()}
    ${lessonModal ? lessonModalHTML() : ''}
    ${studentModal ? studentModalHTML() : ''}
    ${confirmModal ? confirmModalHTML() : ''}
  `;
}

function header() {
  const s = monthStats();
  return `
    <header class="hdr">
      <div class="hdr-top">
        <h1>Tutoring</h1>
        ${state.busy ? '<span class="dot-busy" aria-label="Saving"></span>' : ''}
      </div>
      ${state.error ? `<div class="banner err">${esc(state.error)}</div>` : ''}
      ${state.tab === 'overview' ? '' : `
        <div class="hdr-strip">
          <span><b>${money(s.received)}</b> in</span>
          <span class="sep"></span>
          <span class="${s.owed > 0 ? 'owed' : ''}"><b>${money(s.owed)}</b> owed</span>
          ${s.credits > 0 ? `<span class="sep"></span><span><b>${s.credits}</b> prepaid</span>` : ''}
        </div>
      `}
    </header>
  `;
}

function nav() {
  const tabs = [
    ['overview', 'Overview', I.home],
    ['calendar', 'Calendar', I.cal],
    ['lessons', 'Lessons', I.list],
    ['students', 'Students', I.users],
  ];
  return `<nav class="nav">${tabs.map(([id, label, ic]) => `
    <button class="nav-b ${state.tab === id ? 'on' : ''}" data-a="tab" data-v="${id}">
      <span class="icn">${ic}</span><span>${label}</span>
    </button>`).join('')}</nav>`;
}

function tabContent() {
  if (!state.students.length && state.tab !== 'students') return emptyStart();
  if (state.tab === 'overview') return overviewView();
  if (state.tab === 'calendar') return calendarView();
  if (state.tab === 'lessons') return lessonsView();
  if (state.tab === 'students') return studentsView();
  return '';
}

function emptyStart() {
  return `<div class="wrap"><div class="empty">
    <span class="icn big">${I.users}</span>
    <h2>Start with a student</h2>
    <p>Add someone to your roster, then log lessons against them.</p>
    <button class="btn pri" data-a="new-student">Add a student</button>
  </div></div>`;
}

// ---------- Overview ----------
function overviewView() {
  const s = monthStats();
  const month = new Date().toLocaleDateString('en-GB', { month: 'long' });
  const unpaid = unpaidLessons();
  const stale = stalePast();
  const next = nextLessons(3);
  const lowBalance = state.students.filter(x => x.creditsTotal > 0 && x.prepaidBalance === 0);

  return `<div class="wrap">
    <section class="ledger">
      <div class="ledger-h"><span>${month}</span></div>
      <div class="ledger-hero">
        <div>
          <span class="lbl">Received</span>
          <span class="big-num in">${money(s.received)}</span>
        </div>
        <div class="ledger-div"></div>
        <div>
          <span class="lbl">Outstanding</span>
          <span class="big-num ${s.owed > 0 ? 'out' : 'zero'}">${money(s.owed)}</span>
        </div>
      </div>
      <div class="ledger-foot">
        <span>${s.done} done</span><i></i>
        <span>${s.upcoming} upcoming</span><i></i>
        <span>${s.credits} prepaid credit${s.credits === 1 ? '' : 's'}</span>
      </div>
    </section>

    ${stale.length ? `
      <div class="nudge">
        <div>
          <b>${stale.length} past lesson${stale.length === 1 ? '' : 's'} still marked scheduled.</b>
          <span>Marking them done applies any prepaid credits.</span>
        </div>
        <button class="btn sm pri" data-a="complete-past">Mark done</button>
      </div>` : ''}

    ${lowBalance.length ? `
      <div class="nudge soft">
        <div>
          <b>${lowBalance.map(x => esc(x.name)).join(', ')}</b>
          <span>Prepaid block used up — time to top up.</span>
        </div>
      </div>` : ''}

    ${unpaid.length ? `
      <h3 class="sec">Awaiting payment <span class="sec-n">${money(unpaid.reduce((a, l) => a + l.amount, 0))}</span></h3>
      <div class="rows">${unpaid.slice(0, 6).map(lessonRow).join('')}</div>
      ${unpaid.length > 6 ? `<button class="more" data-a="tab" data-v="lessons">See all ${unpaid.length}</button>` : ''}
    ` : ''}

    ${next.length ? `
      <h3 class="sec">Coming up</h3>
      <div class="rows">${next.map(lessonRow).join('')}</div>
    ` : ''}

    ${!unpaid.length && !next.length && !stale.length ? `
      <div class="empty sm"><p>Nothing outstanding, nothing scheduled.</p></div>` : ''}
  </div>`;
}

// ---------- Lesson row ----------
function payChip(l) {
  if (l.viaPrepay) return `<span class="chip prepaid">${I.coins}Prepaid</span>`;
  if (l.paidCash) return `<span class="chip paid">${I.check}Paid</span>`;
  if (l.status === 'cancelled') return `<span class="chip void">—</span>`;
  if (l.status === 'scheduled') return `<span class="chip due">Due</span>`;
  return `<span class="chip unpaid">Unpaid</span>`;
}

function lessonRow(l, opts) {
  const st = studentById(l.studentId);
  const showDate = !(opts && opts.hideDate);
  return `
    <div class="row ${l.status === 'cancelled' ? 'is-void' : ''}">
      <button class="row-main" data-a="open-lesson" data-id="${l.id}">
        <span class="row-time">
          <b>${esc(l.time)}</b>
          ${showDate ? `<i>${fmtDay(l.date)}</i>` : `<i>${l.duration}m</i>`}
        </span>
        <span class="row-body">
          <span class="row-name">
            <span class="pip" style="background:${st ? st.color : '#a8a29e'}"></span>
            ${st ? esc(st.name) : 'Unknown'}
          </span>
          <span class="row-sub">${esc(l.subject)}${st && st.grade ? ' · ' + esc(st.grade) : ''}${l.status === 'scheduled' ? '' : ' · ' + STATUS_LABELS[l.status]}</span>
        </span>
      </button>
      <button class="row-pay" data-a="toggle-paid" data-id="${l.id}" title="Toggle paid">
        <span class="row-amt">${money(l.amount)}</span>
        ${payChip(l)}
      </button>
    </div>`;
}

function groupedRows(lessons) {
  const groups = {};
  lessons.forEach(l => { (groups[l.date] = groups[l.date] || []).push(l); });
  const dates = Object.keys(groups).sort();
  return dates.map(d => `
    <div class="grp">
      <div class="grp-h"><span>${fmtDayLong(d)}</span><i></i></div>
      <div class="rows">${groups[d].sort((a, b) => a.time.localeCompare(b.time)).map(l => lessonRow(l, { hideDate: true })).join('')}</div>
    </div>`).join('');
}

// ---------- Calendar ----------
function calendarView() {
  const cells = monthGrid(state.calendarMonth);
  const today = todayISO();
  const day = lessonsFor(state.selectedDate);

  return `<div class="wrap">
    <div class="cal-h">
      <button class="ib" data-a="cal" data-v="-1">${I.left}</button>
      <span>${fmtMonth(state.calendarMonth)}</span>
      <button class="ib" data-a="cal" data-v="1">${I.right}</button>
    </div>
    <div class="cal">
      ${WEEKDAYS.map(d => `<div class="cal-wd">${d}</div>`).join('')}
      ${cells.map(dt => {
        if (!dt) return '<div></div>';
        const iso = toISO(dt);
        const ls = lessonsFor(iso);
        const cls = [
          iso === state.selectedDate ? 'on' : '',
          iso === today ? 'today' : '',
          ls.some(l => l.status === 'completed' && !l.paid) ? 'flag' : '',
        ].join(' ');
        return `<button class="cal-d ${cls}" data-a="pick-date" data-v="${iso}">
          <b>${dt.getDate()}</b>
          ${ls.length ? `<span class="pips">${ls.slice(0, 4).map(l => {
            const st = studentById(l.studentId);
            return `<i style="background:${st ? st.color : '#a8a29e'}"></i>`;
          }).join('')}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    <div class="day">
      <div class="day-h">
        <h3>${fmtDayLong(state.selectedDate)}</h3>
        <button class="btn sm ghost" data-a="new-lesson-here">${I.plus} Add</button>
      </div>
      ${day.length ? `<div class="rows">${day.map(l => lessonRow(l, { hideDate: true })).join('')}</div>`
        : '<p class="none">No lessons.</p>'}
    </div>
  </div>`;
}

// ---------- Lessons ----------
function lessonsView() {
  const today = todayISO();
  let ls = state.lessons.filter(l => {
    if (state.filterStatus !== 'all' && l.status !== state.filterStatus) return false;
    if (state.filterPaid === 'paid' && !l.paid) return false;
    if (state.filterPaid === 'unpaid' && l.paid) return false;
    if (state.filterStudent !== 'all' && l.studentId !== state.filterStudent) return false;
    return true;
  });
  const upcoming = ls.filter(l => l.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = ls.filter(l => l.date < today).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const chip = (label, on, a, v) => `<button class="fchip ${on ? 'on' : ''}" data-a="${a}" data-v="${v}">${label}</button>`;

  return `<div class="wrap">
    <div class="filters">
      ${chip('All', state.filterStatus === 'all' && state.filterPaid === 'all', 'filter-clear', '')}
      <i class="fsep"></i>
      ${chip('Unpaid', state.filterPaid === 'unpaid', 'filter-paid', 'unpaid')}
      ${chip('Paid', state.filterPaid === 'paid', 'filter-paid', 'paid')}
      <i class="fsep"></i>
      ${chip('Scheduled', state.filterStatus === 'scheduled', 'filter-status', 'scheduled')}
      ${chip('Done', state.filterStatus === 'completed', 'filter-status', 'completed')}
      ${chip('Cancelled', state.filterStatus === 'cancelled', 'filter-status', 'cancelled')}
    </div>
    ${state.students.length > 1 ? `
      <select class="who" data-f="filterStudent">
        <option value="all">All students</option>
        ${state.students.map(s => `<option value="${s.id}" ${state.filterStudent === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>` : ''}
    ${upcoming.length ? `<h3 class="sec">Upcoming</h3>${groupedRows(upcoming)}` : ''}
    ${past.length ? `<h3 class="sec">History</h3>${groupedRows(past.slice(0, 60))}` : ''}
    ${!upcoming.length && !past.length ? '<p class="none">Nothing matches that filter.</p>' : ''}
  </div>`;
}

// ---------- Students ----------
function studentsView() {
  if (!state.students.length) return emptyStart();
  return `<div class="wrap">
    <div class="rows">${state.students.map(s => {
      const mine = state.lessons.filter(l => l.studentId === s.id);
      const done = mine.filter(l => l.status === 'completed').length;
      const owed = mine.filter(l => l.status === 'completed' && !l.paid).reduce((a, l) => a + l.amount, 0);
      return `
        <button class="scard" data-a="edit-student" data-id="${s.id}">
          <span class="av" style="background:${s.color}">${esc(s.name.trim().charAt(0).toUpperCase())}</span>
          <span class="scard-b">
            <span class="scard-n">${esc(s.name)}</span>
            <span class="scard-s">${esc(s.subject)}${s.grade ? ' · ' + esc(s.grade) : ''} · ${money(s.rate)}/h · ${done} done</span>
          </span>
          <span class="scard-r">
            ${s.prepaidBalance > 0
              ? `<span class="bal ok">${s.prepaidBalance}<i>prepaid</i></span>`
              : owed > 0
                ? `<span class="bal due">${money(owed)}<i>owed</i></span>`
                : `<span class="bal none">·</span>`}
          </span>
        </button>`;
    }).join('')}</div>
    <button class="reset" data-a="ask-reset">Reset all data</button>
  </div>`;
}

// ---------- Lesson modal ----------
function lessonModalHTML() {
  const f = lessonModal;
  const isNew = !f.id;
  const st = studentById(f.studentId);
  const bal = st ? st.prepaidBalance : 0;
  const willPrepay = isNew && f.status === 'completed' && !f.paidCash && bal > 0;

  return `<div class="ov" data-ov="lesson"><div class="sheet">
    <div class="sheet-h">
      <h2>${isNew ? 'New lesson' : 'Lesson'}</h2>
      <button class="ib" data-a="close-lesson">${I.x}</button>
    </div>

    <label class="fl">Student</label>
    <select data-f="studentId">
      ${state.students.map(s => `<option value="${s.id}" ${s.id === f.studentId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>

    <div class="two">
      <div><label class="fl">Date</label><input type="date" data-f="date" value="${f.date}"></div>
      <div><label class="fl">Time</label><input type="time" data-f="time" value="${f.time}"></div>
    </div>

    <div class="two">
      <div><label class="fl">Minutes</label><input type="number" min="15" step="15" data-f="duration" value="${f.duration}"></div>
      <div><label class="fl">Amount (€)</label><input type="number" min="0" step="0.5" data-f="amount" value="${f.amount}"></div>
    </div>

    <label class="fl">Subject</label>
    <select data-f="subject">
      ${SUBJECTS.map(s => `<option value="${s}" ${s === f.subject ? 'selected' : ''}>${s}</option>`).join('')}
    </select>

    <label class="fl">Status</label>
    <div class="seg">
      ${Object.keys(STATUS_LABELS).map(k => `
        <button class="seg-b ${f.status === k ? 'on ' + k : ''}" data-a="set-status" data-v="${k}">${STATUS_LABELS[k]}</button>`).join('')}
    </div>

    ${isNew ? `
      <label class="fl">More dates <i class="hint">same time, same student</i></label>
      <div class="adder">
        <input type="date" id="xdate">
        <button class="btn sm" data-a="add-date">Add</button>
      </div>
      ${f.extra.length ? `<div class="chips">${f.extra.map((d, i) =>
        `<span class="dchip">${fmtDay(d)}<button data-a="rm-date" data-v="${i}">${I.x}</button></span>`).join('')}</div>` : ''}
      <div class="weekly">
        <span>Repeat weekly</span>
        <input type="number" min="1" max="52" id="wk" value="4">
        <span>×</span>
        <button class="btn sm ghost" data-a="add-weekly">Add</button>
      </div>
    ` : ''}

    <label class="fl">Payment</label>
    ${f.viaPrepay ? `
      <div class="paystate prepaid">
        ${I.coins}<div><b>Covered by a prepaid credit</b><span>Deducted from ${st ? esc(st.name) : 'their'} balance automatically.</span></div>
      </div>
      <button class="btn ghost wide" data-a="modal-unpay">Mark as not paid</button>
    ` : f.paidCash ? `
      <div class="paystate paid">
        ${I.check}<div><b>Paid directly</b><span>Cash or transfer, recorded against this lesson.</span></div>
      </div>
      <button class="btn ghost wide" data-a="modal-unpay">Mark as not paid</button>
    ` : `
      ${willPrepay ? `<div class="paystate hintbox">${I.coins}<div><b>Will use a prepaid credit</b><span>${st ? esc(st.name) : 'They'} ${bal === 1 ? 'has 1 credit' : 'has ' + bal + ' credits'} left — saving this as done uses one.</span></div></div>`
        : (!isNew && f.status === 'completed' && bal > 0)
          ? `<div class="paystate hintbox">${I.coins}<div><b>${bal} prepaid credit${bal === 1 ? '' : 's'} available</b><span>Saving will apply one automatically.</span></div></div>`
          : ''}
      <button class="btn wide ${willPrepay ? 'ghost' : 'pri'}" data-a="modal-pay">Mark paid directly</button>
    `}

    <label class="fl">Notes</label>
    <textarea data-f="notes" rows="2" placeholder="Optional">${esc(f.notes || '')}</textarea>

    <div class="acts">
      ${!isNew ? `<button class="btn dang-o" data-a="ask-del-lesson">${I.trash}</button>` : ''}
      <button class="btn" data-a="close-lesson">Cancel</button>
      <button class="btn pri grow" data-a="save-lesson">${isNew && f.extra.length ? `Save ${f.extra.length + 1} lessons` : 'Save'}</button>
    </div>
  </div></div>`;
}

// ---------- Student modal ----------
function studentModalHTML() {
  const f = studentModal;
  const isNew = !f.id;
  const hist = isNew ? [] : paymentsFor(f.id);

  return `<div class="ov" data-ov="student"><div class="sheet">
    <div class="sheet-h">
      <h2>${isNew ? 'New student' : esc(f.name)}</h2>
      <button class="ib" data-a="close-student">${I.x}</button>
    </div>

    <label class="fl">Name</label>
    <input type="text" data-f="name" value="${esc(f.name)}" placeholder="Full name">

    <div class="two">
      <div><label class="fl">Subject</label>
        <select data-f="subject">${SUBJECTS.map(s => `<option value="${s}" ${s === f.subject ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div><label class="fl">Grade</label><input type="text" data-f="grade" value="${esc(f.grade || '')}" placeholder="e.g. 11"></div>
    </div>

    <label class="fl">Rate (€ per hour)</label>
    <input type="number" min="0" step="1" data-f="rate" value="${f.rate}">

    ${isNew ? '' : `
      <div class="prepay">
        <div class="prepay-h">
          <div>
            <span class="prepay-n">${f.prepaidBalance}</span>
            <span class="prepay-l">lesson${f.prepaidBalance === 1 ? '' : 's'} prepaid</span>
          </div>
          ${prepayForm ? '' : `<button class="btn sm pri" data-a="open-prepay">${I.plus} Top up</button>`}
        </div>
        <p class="prepay-x">${f.creditsUsed} of ${f.creditsTotal} used. Credits apply themselves to completed lessons, oldest first.</p>

        ${prepayForm ? `
          <div class="prepay-form">
            <div class="two">
              <div><label class="fl">Lessons</label><input type="number" min="1" data-f="ppCount" value="${prepayForm.lessonsCount}"></div>
              <div><label class="fl">Paid (€)</label><input type="number" min="0" step="0.5" data-f="ppAmount" value="${prepayForm.amount}"></div>
            </div>
            <label class="fl">Date received</label>
            <input type="date" data-f="ppDate" value="${prepayForm.date}">
            <div class="acts">
              <button class="btn" data-a="cancel-prepay">Cancel</button>
              <button class="btn pri grow" data-a="save-prepay">Record payment</button>
            </div>
          </div>` : ''}

        ${hist.length ? `<div class="phist">${hist.map(p => `
          <div class="phist-r">
            <span>${fmtDay(p.date)}</span>
            <span>${p.lessonsCount} × lesson</span>
            <b>${money(p.amount)}</b>
            <button class="ib sm" data-a="ask-del-payment" data-id="${p.id}">${I.trash}</button>
          </div>`).join('')}</div>` : ''}
      </div>`}

    <div class="acts">
      ${isNew ? '' : `<button class="btn dang-o" data-a="ask-del-student">${I.trash}</button>`}
      <button class="btn" data-a="close-student">Cancel</button>
      <button class="btn pri grow" data-a="save-student">Save</button>
    </div>
  </div></div>`;
}

function confirmModalHTML() {
  return `<div class="ov top" data-ov="confirm"><div class="sheet narrow">
    <p class="cmsg">${esc(confirmModal.message)}</p>
    <div class="acts">
      <button class="btn grow" data-a="cancel-confirm">Cancel</button>
      <button class="btn dang grow" data-a="do-confirm">${esc(confirmModal.verb || 'Delete')}</button>
    </div>
  </div></div>`;
}

// ---------- Openers ----------
function statusForDate(date) {
  return date < todayISO() ? 'completed' : 'scheduled';
}
function openNewLesson(date) {
  if (!state.students.length) { state.tab = 'students'; openNewStudent(); return; }
  const s = state.students[0];
  const d = date || todayISO();
  lessonModal = {
    id: null, studentId: s.id, date: d, time: '15:00', duration: 60,
    subject: s.subject, amount: s.rate, status: statusForDate(d),
    paidCash: false, viaPrepay: false, notes: '', extra: [],
  };
  render();
}
function openNewStudent() {
  studentModal = { id: null, name: '', subject: SUBJECTS[0], grade: '', rate: 20 };
  prepayForm = null;
  render();
}

// ---------- Saves ----------
function saveLesson() {
  const f = lessonModal;
  if (!f.studentId || !f.date || !f.time) return;
  const body = {
    studentId: f.studentId, time: f.time, duration: f.duration, subject: f.subject,
    amount: f.amount, status: f.status, paidCash: f.paidCash, notes: f.notes,
  };
  if (f.id) {
    lessonModal = null;
    mutate('/lessons/' + f.id, { method: 'PUT', body: JSON.stringify({ ...body, date: f.date }) });
  } else {
    const dates = [f.date, ...f.extra];
    lessonModal = null;
    mutate('/lessons', { method: 'POST', body: JSON.stringify({ ...body, dates }) });
  }
}

function saveStudent() {
  const f = studentModal;
  if (!f.name.trim()) return;
  const body = { name: f.name.trim(), subject: f.subject, grade: f.grade, rate: f.rate, color: f.color };
  if (f.id) {
    studentModal = null; prepayForm = null;
    mutate('/students/' + f.id, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    body.color = COLORS[state.students.length % COLORS.length];
    studentModal = null; prepayForm = null;
    mutate('/students', { method: 'POST', body: JSON.stringify(body) });
  }
}

async function savePrepay() {
  const f = studentModal, p = prepayForm;
  if (!p || !Number(p.lessonsCount)) return;
  const id = f.id;
  prepayForm = null;
  await mutate('/students/' + id + '/prepayments', {
    method: 'POST',
    body: JSON.stringify({ lessonsCount: Number(p.lessonsCount), amount: Number(p.amount), date: p.date }),
  });
  // Keep the sheet open, refreshed with the new balance.
  const fresh = studentById(id);
  if (fresh && studentModal) studentModal = { ...fresh };
  render();
}

async function doConfirm() {
  const c = confirmModal;
  confirmModal = null;
  if (c.type === 'lesson') { lessonModal = null; await mutate('/lessons/' + c.id, { method: 'DELETE' }); }
  else if (c.type === 'student') { studentModal = null; await mutate('/students/' + c.id, { method: 'DELETE' }); }
  else if (c.type === 'payment') {
    const sid = studentModal ? studentModal.id : null;
    await mutate('/payments/' + c.id, { method: 'DELETE' });
    const fresh = sid ? studentById(sid) : null;
    if (fresh && studentModal) studentModal = { ...fresh };
    render();
  }
  else if (c.type === 'reset') { await mutate('/reset', { method: 'POST' }); }
}

// ---------- Events ----------
document.addEventListener('click', (e) => {
  const ov = e.target.closest('.ov');
  if (ov && e.target === ov) {
    if (ov.dataset.ov === 'confirm') confirmModal = null;
    else if (ov.dataset.ov === 'lesson') lessonModal = null;
    else { studentModal = null; prepayForm = null; }
    render();
    return;
  }
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a, v = el.dataset.v, id = el.dataset.id;

  switch (a) {
    case 'tab': state.tab = v; render(); break;
    case 'new-lesson': openNewLesson(todayISO()); break;
    case 'new-lesson-here': openNewLesson(state.selectedDate); break;
    case 'new-student': openNewStudent(); break;
    case 'open-lesson': {
      const l = lessonById(id);
      if (l) { lessonModal = { ...l, extra: [] }; render(); }
      break;
    }
    case 'edit-student': {
      const s = studentById(id);
      if (s) { studentModal = { ...s }; prepayForm = null; render(); }
      break;
    }
    case 'toggle-paid': mutate('/lessons/' + id + '/paid', { method: 'PATCH' }); break;
    case 'complete-past': mutate('/lessons/complete-past', { method: 'POST' }); break;
    case 'cal':
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + Number(v), 1);
      render(); break;
    case 'pick-date': state.selectedDate = v; render(); break;
    case 'filter-status':
      state.filterStatus = state.filterStatus === v ? 'all' : v; render(); break;
    case 'filter-paid':
      state.filterPaid = state.filterPaid === v ? 'all' : v; render(); break;
    case 'filter-clear':
      state.filterStatus = 'all'; state.filterPaid = 'all'; render(); break;
    case 'set-status':
      lessonModal.status = v; render(); break;
    case 'add-date': {
      const inp = document.getElementById('xdate');
      if (inp && inp.value && lessonModal) {
        const d = inp.value;
        if (d !== lessonModal.date && !lessonModal.extra.includes(d)) {
          lessonModal.extra.push(d); lessonModal.extra.sort();
        }
        render();
      }
      break;
    }
    case 'rm-date': lessonModal.extra.splice(Number(v), 1); render(); break;
    case 'add-weekly': {
      const wk = document.getElementById('wk');
      const n = wk ? Math.min(52, Math.max(1, Number(wk.value) || 4)) : 4;
      const all = [lessonModal.date, ...lessonModal.extra].sort();
      const cur = parseISO(all[all.length - 1]);
      for (let i = 0; i < n; i++) {
        cur.setDate(cur.getDate() + 7);
        const iso = toISO(cur);
        if (!lessonModal.extra.includes(iso) && iso !== lessonModal.date) lessonModal.extra.push(iso);
      }
      lessonModal.extra.sort();
      render();
      break;
    }
    case 'modal-pay': lessonModal.paidCash = true; render(); break;
    case 'modal-unpay': lessonModal.paidCash = false; lessonModal.viaPrepay = false; render(); break;
    case 'save-lesson': saveLesson(); break;
    case 'close-lesson': lessonModal = null; render(); break;
    case 'save-student': saveStudent(); break;
    case 'close-student': studentModal = null; prepayForm = null; render(); break;
    case 'open-prepay':
      prepayForm = { lessonsCount: 4, amount: (studentModal.rate * 4).toFixed(2), date: todayISO() };
      render(); break;
    case 'cancel-prepay': prepayForm = null; render(); break;
    case 'save-prepay': savePrepay(); break;
    case 'ask-del-lesson':
      confirmModal = { type: 'lesson', id: lessonModal.id, message: 'Delete this lesson? Any credit it used goes back to the student.' };
      render(); break;
    case 'ask-del-student':
      confirmModal = { type: 'student', id: studentModal.id, message: `Delete ${studentModal.name}? Their lessons and payment history go too.` };
      render(); break;
    case 'ask-del-payment':
      confirmModal = { type: 'payment', id, message: 'Remove this payment? Lessons it covered become unpaid again.' };
      render(); break;
    case 'ask-reset':
      confirmModal = { type: 'reset', message: 'Delete every student, lesson and payment? This cannot be undone.', verb: 'Erase all' };
      render(); break;
    case 'cancel-confirm': confirmModal = null; render(); break;
    case 'do-confirm': doConfirm(); break;
  }
});

// Typing: update state silently so focus and cursor survive.
document.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  if (!f || e.target.tagName === 'SELECT') return;

  if (lessonModal) {
    if (f === 'duration') {
      lessonModal.duration = Number(e.target.value) || 0;
      const s = studentById(lessonModal.studentId);
      if (s) {
        lessonModal.amount = Number((s.rate * (lessonModal.duration / 60)).toFixed(2));
        const amt = document.querySelector('[data-f="amount"]');
        if (amt) amt.value = lessonModal.amount;
      }
      return;
    }
    if (f === 'amount') { lessonModal.amount = Number(e.target.value) || 0; return; }
    if (f === 'time') { lessonModal.time = e.target.value; return; }
    if (f === 'notes') { lessonModal.notes = e.target.value; return; }
    if (f === 'date') {
      const wasAuto = lessonModal.status === statusForDate(lessonModal.date);
      lessonModal.date = e.target.value;
      // Keep status sensible for the new date unless it was set by hand.
      if (wasAuto && !lessonModal.id) { lessonModal.status = statusForDate(e.target.value); render(); }
      return;
    }
  }
  if (studentModal) {
    if (f === 'name') { studentModal.name = e.target.value; return; }
    if (f === 'grade') { studentModal.grade = e.target.value; return; }
    if (f === 'rate') {
      studentModal.rate = Number(e.target.value) || 0;
      if (prepayForm) {
        prepayForm.amount = (studentModal.rate * Number(prepayForm.lessonsCount || 0)).toFixed(2);
        const amt = document.querySelector('[data-f="ppAmount"]');
        if (amt) amt.value = prepayForm.amount;
      }
      return;
    }
  }
  if (prepayForm) {
    if (f === 'ppCount') {
      prepayForm.lessonsCount = Number(e.target.value) || 0;
      prepayForm.amount = (Number(studentModal.rate) * prepayForm.lessonsCount).toFixed(2);
      const amt = document.querySelector('[data-f="ppAmount"]');
      if (amt) amt.value = prepayForm.amount;
      return;
    }
    if (f === 'ppAmount') { prepayForm.amount = e.target.value; return; }
    if (f === 'ppDate') { prepayForm.date = e.target.value; return; }
  }
});

// Dropdowns: discrete, safe to re-render.
document.addEventListener('change', (e) => {
  const f = e.target.dataset.f;
  const filterField = e.target.dataset.filter || (e.target.classList.contains('who') ? 'filterStudent' : null);
  if (filterField) { state.filterStudent = e.target.value; render(); return; }
  if (!f || e.target.tagName !== 'SELECT') return;

  if (lessonModal && f === 'studentId') {
    lessonModal.studentId = e.target.value;
    const s = studentById(e.target.value);
    if (s) {
      lessonModal.subject = s.subject;
      lessonModal.amount = Number((s.rate * (lessonModal.duration / 60)).toFixed(2));
    }
    render(); return;
  }
  if (lessonModal && f === 'subject') { lessonModal.subject = e.target.value; return; }
  if (studentModal && f === 'subject') { studentModal.subject = e.target.value; return; }
});

// ---------- Init ----------
(async function init() {
  render();
  try {
    const data = await call('/state');
    state.students = data.students;
    state.lessons = data.lessons;
    state.payments = data.payments;
  } catch (e) {
    state.error = 'Could not reach the server.';
  }
  state.loaded = true;
  render();
})();
