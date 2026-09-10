// ---------- Constants ----------
// Change this one line to rename the app.
const APP_NAME = 'Pamoka';
const SUBJECTS = ['Mathematics', 'Economics', 'Other'];
const COLORS = ['#2F6B4F', '#8B4A2B', '#3B5A6B', '#7A5C2E', '#6B3F5C', '#4A6B3F', '#8B3A3A', '#3F5C6B'];
const STATUS_LABELS = { scheduled: 'Scheduled', completed: 'Done', cancelled: 'Cancelled' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ---------- State ----------
let state = {
  students: [],
  lessons: [],
  payments: [],
  curriculum: [],
  tab: 'overview',
  loaded: false,
  busy: false,
  error: null,
  calendarMonth: new Date(),
  selectedDate: todayISO(),
  filterStatus: 'all',
  filterPaid: 'all',
  filterStudent: 'all',
  chartMode: 'earned',
  selecting: false,
  selected: {},
  weekStart: mondayOf(new Date()),
};

const WIDE = () => window.matchMedia('(min-width: 860px)').matches;
let lessonModal = null;
let studentModal = null;
let confirmModal = null;
let prepayForm = null;
let curForm = null;

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
function mondayOf(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}
function hhmm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
// Grid clock labels wrap past midnight: 1440 -> 00:00, 1500 -> 01:00.
function clockLabel(mins) {
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function weekLabel(start) {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const left = sameMonth
    ? String(start.getDate())
    : start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const right = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const year = start.getFullYear() !== new Date().getFullYear() ? ' ' + start.getFullYear() : '';
  return `${left} – ${right}${year}`;
}

// Hex -> rgba, for translucent lesson blocks.
function tint(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function money(n) { return '€' + Number(n || 0).toFixed(2); }
// What a lesson is actually worth: its share of the payment that covered it,
// or the standard price if nothing has covered it yet.
function value(l) { return Number(l.effectiveAmount != null ? l.effectiveAmount : l.amount) || 0; }

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
    state.curriculum = data.curriculum || [];
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
  const today = todayISO();
  let earned = 0, collected = 0, owed = 0, done = 0, upcoming = 0;
  state.lessons.forEach(l => {
    const inMonth = l.date.startsWith(ym);
    // Earned = work delivered this month, however it was paid for.
    if (l.status === 'completed' && inMonth) { earned += value(l); done += 1; }
    // Collected = cash that actually landed against a lesson this month.
    if (l.paidCash && inMonth) collected += value(l);
    if (l.status === 'completed' && !l.paid) owed += value(l);
    if (l.status === 'scheduled' && l.date >= today) upcoming += 1;
  });
  // Prepayment money counts as collected in the month it was received.
  state.payments.forEach(p => { if (p.date.startsWith(ym)) collected += p.amount; });
  const credits = state.students.reduce((s, x) => s + Math.max(0, x.prepaidBalance), 0);
  return { earned, collected, owed, done, upcoming, credits };
}

// Outstanding lessons grouped by student, biggest debt first.
// Revenue history. Two different questions, so two different numbers:
//   earned    = value of lessons actually taught that month
//   collected = money that landed that month (payments + directly paid lessons)
// Prepayments make these diverge on purpose — cash arrives before the teaching.
function monthlySeries(count) {
  const now = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({
      ym,
      date: d,
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      year: d.getFullYear(),
      earned: 0, collected: 0, scheduled: 0, lessons: 0,
      isCurrent: i === 0,
    });
  }
  const idx = {};
  out.forEach(m => { idx[m.ym] = m; });

  state.lessons.forEach(l => {
    const m = idx[l.date.slice(0, 7)];
    if (!m) return;
    if (l.status === 'completed') { m.earned += value(l); m.lessons += 1; }
    if (l.status === 'scheduled') m.scheduled += value(l);
    if (l.paidCash) m.collected += value(l);
  });
  state.payments.forEach(p => {
    const m = idx[p.date.slice(0, 7)];
    if (m) m.collected += p.amount;
  });
  return out;
}

function owedByStudent() {
  const map = {};
  unpaidLessons().forEach(l => {
    if (!map[l.studentId]) map[l.studentId] = { student: studentById(l.studentId), lessons: [], total: 0 };
    map[l.studentId].lessons.push(l);
    map[l.studentId].total += value(l);
  });
  return Object.values(map).filter(g => g.student).sort((a, b) => b.total - a.total);
}

function owedFor(studentId) {
  return state.lessons
    .filter(l => l.studentId === studentId && l.status === 'completed' && !l.paid)
    .reduce((a, l) => a + value(l), 0);
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
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6.5A6 6 0 0 0 8 12a6 6 0 0 0 9 5.5"/><path d="M4 10.5h8M4 14h8"/></svg>',
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
      : state.tab === 'curriculum'
        ? `<button class="fab" data-a="new-cur" aria-label="Add weekly slot">${I.plus}</button>`
        : `<button class="fab" data-a="new-lesson" aria-label="Add lesson">${I.plus}</button>`}
    ${selBar()}
    ${nav()}
    ${lessonModal ? lessonModalHTML() : ''}
    ${studentModal ? studentModalHTML() : ''}
    ${curForm ? curModalHTML() : ''}
    ${confirmModal ? confirmModalHTML() : ''}
  `;
}

function header() {
  const s = monthStats();
  return `
    <header class="hdr">
      <div class="hdr-top">
        <h1>Tally</h1>
        ${state.busy ? '<span class="dot-busy" aria-label="Saving"></span>' : ''}
      </div>
      ${state.error ? `<div class="banner err">${esc(state.error)}</div>` : ''}
      ${state.tab === 'overview' ? '' : `
        <div class="hdr-strip">
          <span><b>${money(s.earned)}</b> earned</span>
          <span class="sep"></span>
          <span class="${s.owed > 0 ? 'owed' : ''}"><b>${money(s.owed)}</b> owed</span>
          ${s.credits > 0 ? `<span class="sep"></span><span><b>${s.credits}</b> prepaid</span>` : ''}
        </div>
      `}
    </header>
  `;
}

function selBar() {
  if (!state.selecting) return '';
  const ids = Object.keys(state.selected).filter(k => state.selected[k]);
  const total = ids.reduce((a, id) => { const l = lessonById(id); return a + (l ? value(l) : 0); }, 0);
  return `<div class="selbar">
    <div class="selbar-i"><b>${ids.length} selected</b>${ids.length ? `<span>${money(total)}</span>` : ''}</div>
    <button class="btn sm" data-a="sel-cancel">Cancel</button>
    <button class="btn sm ghost" data-a="sel-unpay" ${ids.length ? '' : 'disabled'}>Unpaid</button>
    <button class="btn sm pri" data-a="sel-pay" ${ids.length ? '' : 'disabled'}>Mark paid</button>
  </div>`;
}

function nav() {
  const tabs = [
    ['overview', 'Overview', I.home],
    ['calendar', 'Calendar', I.cal],
    ['curriculum', 'Weekly', I.repeat],
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
  if (state.tab === 'calendar') return WIDE() ? weekView() : calendarView();
  if (state.tab === 'curriculum') return curriculumView();
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
  const groups = owedByStudent();
  const stale = stalePast();
  const next = nextLessons(3);
  const lowBalance = state.students.filter(x => x.creditsTotal > 0 && x.prepaidBalance === 0 && owedFor(x.id) === 0);

  return `<div class="wrap">
    <section class="ledger">
      <div class="ledger-h"><span>${month}</span></div>
      <div class="ledger-hero">
        <div>
          <span class="lbl">Earned</span>
          <span class="big-num in">${money(s.earned)}</span>
          <span class="sub-num">${s.done} lesson${s.done === 1 ? '' : 's'} delivered</span>
        </div>
        <div class="ledger-div"></div>
        <div>
          <span class="lbl">Outstanding</span>
          <span class="big-num ${s.owed > 0 ? 'out' : 'zero'}">${money(s.owed)}</span>
          <span class="sub-num">${s.owed > 0 ? 'across ' + groups.length + ' student' + (groups.length === 1 ? '' : 's') : 'all settled'}</span>
        </div>
      </div>
      <div class="ledger-foot">
        <span>${money(s.collected)} cash in</span><i></i>
        <span>${s.upcoming} upcoming</span><i></i>
        <span>${s.credits} prepaid credit${s.credits === 1 ? '' : 's'}</span>
      </div>
    </section>

    ${revenueSection()}

    ${stale.length ? `
      <div class="nudge">
        <div>
          <b>${stale.length} past lesson${stale.length === 1 ? '' : 's'} still marked scheduled.</b>
          <span>Marking them done counts them as earned and applies prepaid credits.</span>
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

    ${groups.length ? `
      <h3 class="sec">Awaiting payment <span class="sec-n">${money(s.owed)}</span></h3>
      ${groups.map(g => `
        <div class="owe">
          <div class="owe-h">
            <span class="av sm" style="background:${g.student.color}">${esc(g.student.name.trim().charAt(0).toUpperCase())}</span>
            <span class="owe-b">
              <b>${esc(g.student.name)}</b>
              <i>${g.lessons.length} lesson${g.lessons.length === 1 ? '' : 's'} · ${fmtDay(g.lessons[0].date)} onward</i>
            </span>
            <span class="owe-t">${money(g.total)}</span>
          </div>
          <div class="owe-acts">
            <button class="btn sm pri grow" data-a="settle" data-id="${g.student.id}">Mark all paid</button>
            <button class="btn sm grow" data-a="see-student" data-id="${g.student.id}">View lessons</button>
          </div>
        </div>`).join('')}
    ` : ''}

    ${next.length ? `
      <h3 class="sec">Coming up</h3>
      <div class="rows">${next.map(l => lessonRow(l)).join('')}</div>
    ` : ''}

    ${!groups.length && !next.length && !stale.length ? `
      <div class="empty sm"><p>Nothing outstanding, nothing scheduled.</p></div>` : ''}
  </div>`;
}

function revenueSection() {
  const months = monthlySeries(6);
  const cur = months[months.length - 1];
  const prev = months[months.length - 2];
  const mode = state.chartMode;

  const projected = cur.earned + cur.scheduled;
  const peak = Math.max(1, ...months.map(m =>
    mode === 'earned' ? (m.isCurrent ? m.earned + m.scheduled : m.earned) : m.collected));

  // Months with any activity, for a fair average.
  const past = months.slice(0, -1).filter(m => m.earned > 0 || m.collected > 0);
  const avg = past.length
    ? past.reduce((a, m) => a + (mode === 'earned' ? m.earned : m.collected), 0) / past.length
    : 0;

  const prevVal = mode === 'earned' ? prev.earned : prev.collected;
  const curVal = mode === 'earned' ? projected : cur.collected;
  const delta = prevVal > 0 ? ((curVal - prevVal) / prevVal) * 100 : null;

  return `<section class="rev">
    <div class="rev-h">
      <h3>Revenue</h3>
      <div class="rev-tabs">
        <button class="rev-t ${mode === 'earned' ? 'on' : ''}" data-a="chart-mode" data-v="earned">Taught</button>
        <button class="rev-t ${mode === 'collected' ? 'on' : ''}" data-a="chart-mode" data-v="collected">Received</button>
      </div>
    </div>

    <div class="bars">
      ${months.map(m => {
        const solid = mode === 'earned' ? m.earned : m.collected;
        const proj = (mode === 'earned' && m.isCurrent) ? m.scheduled : 0;
        // A month with no money draws no bar at all — a floor height here
        // renders as a stray green line across empty months.
        const hS = solid > 0 ? Math.max(1.5, (solid / peak) * 100) : 0;
        const hP = proj > 0 ? Math.max(1.5, (proj / peak) * 100) : 0;
        const tip = mode === 'earned'
          ? `${m.label}: ${money(m.earned)} taught${proj ? `, ${money(proj)} still booked` : ''}`
          : `${m.label}: ${money(m.collected)} received`;
        return `<div class="bcol" title="${tip}">
          <div class="bwrap">
            ${hP > 0 ? `<div class="bar proj" style="height:${hP.toFixed(1)}%"></div>` : ''}
            ${hS > 0 ? `<div class="bar ${m.isCurrent ? 'now' : ''}" style="height:${hS.toFixed(1)}%"></div>` : ''}
          </div>
          <span class="blab ${m.isCurrent ? 'on' : ''}">${m.label}</span>
        </div>`;
      }).join('')}
    </div>

    <div class="rev-k">
      <div>
        <span class="lbl">${mode === 'earned' ? 'This month, projected' : 'Received this month'}</span>
        <span class="k-num">${money(curVal)}</span>
        ${mode === 'earned' && cur.scheduled > 0
          ? `<span class="k-sub">${money(cur.earned)} taught · ${money(cur.scheduled)} still booked</span>`
          : `<span class="k-sub">${cur.lessons} lesson${cur.lessons === 1 ? '' : 's'} taught</span>`}
      </div>
      <div>
        <span class="lbl">vs ${prev.label}</span>
        <span class="k-num ${delta == null ? 'flat' : (delta >= 0 ? 'up' : 'down')}">
          ${delta == null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(0) + '%'}
        </span>
        <span class="k-sub">${money(prevVal)} then</span>
      </div>
      <div>
        <span class="lbl">Monthly average</span>
        <span class="k-num">${money(avg)}</span>
        <span class="k-sub">${past.length} month${past.length === 1 ? '' : 's'} of history</span>
      </div>
    </div>
    ${mode === 'earned'
      ? '<p class="rev-x">Value of lessons taught, counted when they happen. The pale part of this month is what\'s still on the calendar.</p>'
      : '<p class="rev-x">Money that actually landed, counted on the day it arrived. Prepaid blocks land in full up front.</p>'}
  </section>`;
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
  if (state.selecting) {
    const on = !!state.selected[l.id];
    return `
      <div class="row sel ${on ? 'on' : ''}">
        <button class="row-main" data-a="toggle-sel" data-id="${l.id}">
          <span class="cbox ${on ? 'on' : ''}">${on ? I.check : ''}</span>
          <span class="row-time"><b>${esc(l.time)}</b><i>${showDate ? fmtDay(l.date) : l.duration + 'm'}</i></span>
          <span class="row-body">
            <span class="row-name"><span class="pip" style="background:${st ? st.color : '#a8a29e'}"></span>${st ? esc(st.name) : 'Unknown'}</span>
            <span class="row-sub">${esc(l.subject)}${l.status === 'scheduled' ? '' : ' · ' + STATUS_LABELS[l.status]}</span>
          </span>
          <span class="row-amt sel-amt">${money(value(l))}</span>
        </button>
      </div>`;
  }
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
          <span class="row-sub">${l.curriculumId ? '<span class="rep-i">' + I.repeat + '</span>' : ''}${esc(l.subject)}${st && st.grade ? ' · ' + esc(st.grade) : ''}${l.status === 'scheduled' ? '' : ' · ' + STATUS_LABELS[l.status]}</span>
        </span>
      </button>
      <button class="row-pay" data-a="toggle-paid" data-id="${l.id}" title="Toggle paid">
        <span class="row-amt">${money(value(l))}</span>
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

// ---------- Curriculum: the generic week that repeats forever ----------
function curriculumView() {
  if (!state.students.length) return emptyStart();

  const byDay = Array.from({ length: 7 }, () => []);
  state.curriculum.forEach(c => { if (byDay[c.weekday]) byDay[c.weekday].push(c); });

  // Same time grid as the calendar, just without dates.
  let from = DEFAULT_START, to = DEFAULT_END;
  state.curriculum.forEach(c => {
    const st = minutesOf(c.time);
    const s0 = st < DAY_BREAK ? st + 1440 : st;
    from = Math.min(from, Math.floor(s0 / 60) * 60);
    to = Math.max(to, Math.ceil((s0 + c.duration) / 60) * 60);
  });
  const hours = [];
  for (let m = from; m < to; m += 60) hours.push(m);
  const total = state.curriculum.length;

  return `<div class="wrap wide">
    <div class="cur-intro">
      <b>Your standard week</b>
      <span>These repeat indefinitely. Deleting a lesson in the calendar skips just that week — remove it here to stop it for good.</span>
    </div>

    <div class="wk" data-grid="cur" data-from="${from}" data-to="${to}" style="--slot:${SLOT_H}px">
      <div class="wk-corner"></div>
      ${DAY_NAMES.map((d, i) => `
        <div class="wk-dh">
          <span class="wk-dn">${WEEKDAYS[i]}</span>
          ${byDay[i].length ? `<span class="wk-dc">${byDay[i].length}</span>` : ''}
        </div>`).join('')}

      <div class="wk-times">
        ${hours.map(m => `<div class="wk-t ${m >= 1440 ? 'night' : ''}" style="height:${SLOT_H}px"><span>${clockLabel(m)}</span></div>`).join('')}
      </div>

      ${DAY_NAMES.map((d, i) => `
        <div class="wk-col" data-wd="${i}" style="height:${hours.length * SLOT_H}px">
          ${hours.map(m => `<button class="wk-slot ${m >= 1440 ? 'night' : ''}" style="height:${SLOT_H}px"
              data-a="new-cur" data-v="${i}" data-t="${clockLabel(m)}"
              aria-label="Add ${DAY_NAMES[i]} ${clockLabel(m)}"></button>`).join('')}
          ${layoutDay(byDay[i].map(c => {
            const st = minutesOf(c.time);
            return { l: { ...c, id: c.id, studentId: c.studentId, time: c.time, duration: c.duration, status: 'scheduled', paid: true }, s: st < DAY_BREAK ? st + 1440 : st };
          }), from).map(b => curBlockHTML(b)).join('')}
        </div>`).join('')}
    </div>
    <p class="wk-hint">${total} slot${total === 1 ? '' : 's'} a week${total ? ' · ' + money(state.curriculum.reduce((a, c) => a + c.amount, 0)) + ' if all go ahead' : ''} · drag to rearrange, click a free slot to add one</p>
  </div>`;
}

function curBlockHTML(b) {
  const c = b.l;
  const st = studentById(c.studentId);
  const col = st ? st.color : '#8a857e';
  const top = ((b.s - b.from) / 60) * SLOT_H;
  const h = Math.max(26, ((b.e - b.s) / 60) * SLOT_H - 3);
  const w = 100 / b.cols;
  const short = h < 42;
  return `<button class="wk-b drg ${short ? 'tiny' : ''}" data-a="edit-cur" data-id="${c.id}" data-dur="${Math.max(20, c.duration)}" data-start="${b.s}"
    style="top:${top}px;height:${h}px;left:calc(${b.col * w}% + 2px);width:calc(${w}% - 4px);
           background:${tint(col, .16)};border-left:3px solid ${col}">
    <span class="wk-bn">${st ? esc(st.name) : 'Unknown'}</span>
    <span class="wk-bt">${clockLabel(b.s)}${short ? '' : `–${clockLabel(b.e)}`}</span>
  </button>`;
}

function curModalHTML() {
  const f = curForm;
  const isNew = !f.id;
  return `<div class="ov" data-ov="cur"><div class="sheet">
    <div class="sheet-h">
      <h2>${isNew ? 'New weekly slot' : 'Weekly slot'}</h2>
      <button class="ib" data-a="close-cur">${I.x}</button>
    </div>
    <div class="rep on" style="margin-bottom:4px">
      ${I.repeat}
      <div><b>Repeats every week</b><span>Lessons appear on the calendar automatically.</span></div>
    </div>

    <label class="fl">Student</label>
    <select data-f="curStudent">
      ${state.students.map(st => `<option value="${st.id}" ${st.id === f.studentId ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}
    </select>

    <label class="fl">Day</label>
    <select data-f="curWeekday">
      ${DAY_NAMES.map((d, i) => `<option value="${i}" ${i === Number(f.weekday) ? 'selected' : ''}>${d}</option>`).join('')}
    </select>

    <div class="two">
      <div><label class="fl">Time</label><input type="time" data-f="curTime" value="${f.time}"></div>
      <div><label class="fl">Minutes</label><input type="number" min="15" step="15" data-f="curDuration" value="${f.duration}"></div>
    </div>

    <div class="two">
      <div><label class="fl">Subject</label>
        <select data-f="curSubject">${SUBJECTS.map(x => `<option value="${x}" ${x === f.subject ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div>
      <div><label class="fl">Amount (€)</label><input type="number" min="0" step="0.5" data-f="curAmount" value="${f.amount}"></div>
    </div>

    ${isNew ? '' : '<p class="fine">Saving rebuilds upcoming lessons from this slot. Completed and paid ones are never touched.</p>'}

    <div class="acts">
      ${isNew ? '' : `<button class="btn dang-o" data-a="ask-del-cur">${I.trash}</button>`}
      <button class="btn" data-a="close-cur">Cancel</button>
      <button class="btn pri grow" data-a="save-cur">Save</button>
    </div>
  </div></div>`;
}

// ---------- Week view (wide screens) ----------
const SLOT_H = 46;              // px per hour
const DEFAULT_START = 8 * 60;   // 08:00
const DEFAULT_END = 25 * 60;    // 01:00 the following morning
const DAY_BREAK = 6 * 60;       // before 06:00 counts as the previous night

function weekView() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const isoDays = days.map(toISO);

  // Each column covers one day from 08:00 through 01:00 of the next morning.
  // A lesson dated Tuesday 00:30 therefore belongs in Monday's column, drawn
  // at 24:30 on the grid.
  const columns = isoDays.map((iso, i) => {
    const nextIso = toISO(addDays(state.weekStart, i + 1));
    const own = state.lessons
      .filter(l => l.date === iso && minutesOf(l.time) >= DAY_BREAK)
      .map(l => ({ l, s: minutesOf(l.time) }));
    const spill = state.lessons
      .filter(l => l.date === nextIso && minutesOf(l.time) < DAY_BREAK)
      .map(l => ({ l, s: minutesOf(l.time) + 1440 }));
    return own.concat(spill);
  });

  // Fit the grid to what's actually booked, never cropping anything.
  let from = DEFAULT_START, to = DEFAULT_END;
  columns.forEach(col => col.forEach(({ l, s }) => {
    from = Math.min(from, Math.floor(s / 60) * 60);
    to = Math.max(to, Math.ceil((s + l.duration) / 60) * 60);
  }));

  const hours = [];
  for (let m = from; m < to; m += 60) hours.push(m);
  const todayIso = todayISO();

  // Current-time marker, drawn across every column so the time is readable
  // anywhere on the grid, with the label sitting on today's column.
  const n = new Date();
  const nowMins = n.getHours() * 60 + n.getMinutes();
  const nowMark = (nowMins >= from && nowMins < to)
    ? { top: ((nowMins - from) / 60) * SLOT_H, label: hhmm(nowMins) }
    : null;

  return `<div class="wrap wide">
    <div class="wk-h">
      <div class="wk-nav">
        <button class="ib" data-a="wk" data-v="-1">${I.left}</button>
        <span class="wk-title">${weekLabel(state.weekStart)}</span>
        <button class="ib" data-a="wk" data-v="1">${I.right}</button>
      </div>
      <button class="btn sm ghost" data-a="wk-today">This week</button>
    </div>

    <div class="wk" data-grid="cal" data-from="${from}" data-to="${to}" style="--slot:${SLOT_H}px">
      <div class="wk-corner"></div>
      ${days.map((d, i) => `
        <div class="wk-dh ${isoDays[i] === todayIso ? 'today' : ''}">
          <span class="wk-dn">${WEEKDAYS[i]}</span>
          <span class="wk-dd">${d.getDate()}</span>
          ${columns[i].length ? `<span class="wk-dc">${columns[i].length}</span>` : ''}
        </div>`).join('')}

      <div class="wk-times">
        ${hours.map(m => `<div class="wk-t ${m >= 1440 ? 'night' : ''}" style="height:${SLOT_H}px"><span>${clockLabel(m)}</span></div>`).join('')}
      </div>

      ${days.map((d, i) => `
        <div class="wk-col ${isoDays[i] === todayIso ? 'today' : ''}" data-date="${isoDays[i]}" data-next="${toISO(addDays(state.weekStart, i + 1))}" style="height:${hours.length * SLOT_H}px">
          ${nowMark ? `<div class="now ${isoDays[i] === todayIso ? 'on' : ''}" style="top:${nowMark.top.toFixed(1)}px">${isoDays[i] === todayIso ? `<span class="now-t">${nowMark.label}</span>` : ''}</div>` : ''}
          ${hours.map(m => {
            const past = m >= 1440;
            const slotDate = past ? toISO(addDays(state.weekStart, i + 1)) : isoDays[i];
            return `<button class="wk-slot ${past ? 'night' : ''}" style="height:${SLOT_H}px"
              data-a="slot" data-v="${slotDate}" data-t="${clockLabel(m)}"
              aria-label="Add lesson ${slotDate} ${clockLabel(m)}"></button>`;
          }).join('')}
          ${layoutDay(columns[i], from).map(b => blockHTML(b)).join('')}
        </div>`).join('')}
    </div>
    <p class="wk-hint">Drag a lesson to reschedule it. Click a free slot to book, or a lesson to edit it.</p>
  </div>`;
}

// Side-by-side placement for lessons that overlap in time.
function layoutDay(entries, from) {
  const items = entries
    .map(({ l, s }) => ({ l, s, e: s + Math.max(20, l.duration) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    cluster.forEach((it, idx) => out.push({ ...it, from, col: idx, cols: cluster.length }));
    cluster = []; clusterEnd = -1;
  };
  items.forEach(it => {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  });
  if (cluster.length) flush();
  return out;
}

function blockHTML(b) {
  const l = b.l;
  const st = studentById(l.studentId);
  const c = st ? st.color : '#8a857e';
  const top = ((b.s - b.from) / 60) * SLOT_H;
  const h = Math.max(26, ((b.e - b.s) / 60) * SLOT_H - 3);
  const w = 100 / b.cols;
  const short = h < 42;
  const state_cls = l.status === 'cancelled' ? 'off' : (l.status === 'completed' && !l.paid ? 'owe' : '');
  return `<button class="wk-b drg ${state_cls} ${short ? 'tiny' : ''}"
    data-a="open-lesson" data-id="${l.id}" data-dur="${Math.max(20, l.duration)}" data-start="${b.s}"
    style="top:${top}px;height:${h}px;left:calc(${b.col * w}% + 2px);width:calc(${w}% - 4px);
           background:${tint(c, .14)};border-left:3px solid ${c}">
    <span class="wk-bn">${st ? esc(st.name) : 'Unknown'}</span>
    <span class="wk-bt">${clockLabel(b.s)}${short ? '' : `–${clockLabel(b.e)}`}${l.status === 'completed' && !l.paid ? ' · unpaid' : ''}</span>
    <span class="wk-act">
      <span class="qb ${l.status === 'completed' ? 'on' : ''}" role="button" tabindex="0"
        data-a="quick-done" data-id="${l.id}"
        title="${l.status === 'completed' ? 'Mark as not done yet' : 'Mark done'}">${I.check}</span>
      <span class="qb ${l.viaPrepay ? 'pre' : (l.paidCash ? 'on' : '')}" role="button" tabindex="0"
        data-a="quick-paid" data-id="${l.id}"
        title="${l.viaPrepay ? 'Covered by a prepaid credit' : (l.paidCash ? 'Mark as unpaid' : 'Mark paid')}">${I.euro}</span>
    </span>
  </button>`;
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

  const shownIds = [...upcoming, ...past].map(l => l.id);
  return `<div class="wrap">
    <div class="toolbar">
      <span class="toolbar-n">${ls.length} lesson${ls.length === 1 ? '' : 's'}</span>
      ${state.selecting
        ? `<button class="btn sm ghost" data-a="sel-all" data-v="${shownIds.join(',')}">Select all shown</button>`
        : `<button class="btn sm ghost" data-a="sel-start">Select</button>`}
    </div>
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
      const owed = mine.filter(l => l.status === 'completed' && !l.paid).reduce((a, l) => a + value(l), 0);
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
      <div><label class="fl">Worth</label>
        <div class="ro">${money(f.viaPrepay && f.effectiveAmount != null ? f.effectiveAmount : f.amount)}</div>
      </div>
    </div>
    <p class="fine">${f.viaPrepay
      ? 'Priced from the payment covering it.'
      : 'Standard rate. Record a prepaid block or single payment to price it from what was actually paid.'}</p>

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
      <p class="fine">Or save it first, then set it to repeat indefinitely.</p>
    ` : `
      ${f.curriculumId ? `
        <label class="fl">Repeats</label>
        <div class="rep on">
          ${I.repeat}
          <div>
            <b>From your weekly curriculum</b>
            <span>Deleting this one only skips this week. Edit the slot to change it for good.</span>
          </div>
        </div>
        <button class="btn ghost wide" data-a="open-cur-from-lesson" data-id="${f.curriculumId}">Open in Curriculum</button>
      ` : ''}
    `}

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
            <span class="prepay-l">lesson${f.prepaidBalance === 1 ? '' : 's'} left of ${f.creditsTotal}</span>
          </div>
          ${prepayForm ? '' : `<button class="btn sm pri" data-a="open-prepay">${I.plus} Add payment</button>`}
        </div>
        ${(() => {
          const hs = paymentsFor(f.id);
          if (!hs.length) return '<p class="prepay-x">Record what was paid for how many lessons. Credits apply themselves to completed lessons, oldest first.</p>';
          const lessonsBought = hs.reduce((a, p) => a + p.lessonsCount, 0);
          const totalPaid = hs.reduce((a, p) => a + p.amount, 0);
          const avg = lessonsBought ? totalPaid / lessonsBought : 0;
          const off = Number(f.rate) - avg;
          return `<p class="prepay-x">${money(totalPaid)} paid for ${lessonsBought} lesson${lessonsBought === 1 ? '' : 's'} — <b>${money(avg)}</b> each${off > 0.005 ? ` (${money(off)} under the ${money(f.rate)} rate)` : ''}. Credits apply themselves to completed lessons, oldest first.</p>`;
        })()}

        ${prepayForm ? `
          <div class="prepay-form">
            <div class="prepay-ft">${prepayForm.id ? 'Edit payment' : 'Record a payment'}</div>
            <div class="seg kindseg">
              <button class="seg-b ${prepayForm.kind === 'prepaid' ? 'on completed' : ''}" data-a="pp-kind" data-v="prepaid">Prepaid block</button>
              <button class="seg-b ${prepayForm.kind === 'single' ? 'on completed' : ''}" data-a="pp-kind" data-v="single">Single lesson</button>
            </div>
            ${prepayForm.kind === 'single' ? `
              <label class="fl">Amount paid (€)</label>
              <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="25" data-f="ppAmount" value="${prepayForm.amount}">
              <div class="perlesson" id="perLesson">${perLessonText(prepayForm)}</div>
            ` : `
              <div class="two">
                <div><label class="fl">Lessons</label><input type="number" min="1" inputmode="numeric" placeholder="4" data-f="ppCount" value="${prepayForm.lessonsCount}"></div>
                <div><label class="fl">Total paid (€)</label><input type="number" min="0" step="0.01" inputmode="decimal" placeholder="85" data-f="ppAmount" value="${prepayForm.amount}"></div>
              </div>
              <div class="perlesson" id="perLesson">${perLessonText(prepayForm)}</div>
            `}
            <label class="fl">Date received</label>
            <input type="date" data-f="ppDate" value="${prepayForm.date}">
            <div class="acts">
              <button class="btn" data-a="cancel-prepay">Cancel</button>
              <button class="btn pri grow" data-a="save-prepay">${prepayForm.id ? 'Save changes' : 'Record payment'}</button>
            </div>
          </div>` : ''}

        ${hist.length ? `<div class="phist">${hist.map(p => `
          <div class="phist-r">
            <button class="phist-m" data-a="edit-prepay" data-id="${p.id}">
              <span>${fmtDay(p.date)}</span>
              <span class="phist-c">${p.kind === 'single' ? 'Single lesson' : `${p.lessonsCount} lessons · ${money(p.amount / p.lessonsCount)} each`}</span>
            </button>
            <b>${money(p.amount)}</b>
            <button class="ib sm" data-a="ask-del-payment" data-id="${p.id}">${I.trash}</button>
          </div>`).join('')}</div>` : ''}
      </div>`}

    ${isNew ? '' : (() => {
      const owed = state.lessons.filter(l => l.studentId === f.id && l.status === 'completed' && !l.paid);
      if (!owed.length) return '';
      const sum = owed.reduce((a, l) => a + value(l), 0);
      return `<button class="btn wide pri settle-btn" data-a="ask-settle" data-id="${f.id}">
        Mark ${owed.length} unpaid lesson${owed.length === 1 ? '' : 's'} paid · ${money(sum)}
      </button>`;
    })()}

    <div class="acts">
      ${isNew ? '' : `<button class="btn dang-o" data-a="ask-del-student">${I.trash}</button>`}
      <button class="btn" data-a="close-student">Cancel</button>
      <button class="btn pri grow" data-a="save-student">Save</button>
    </div>
  </div></div>`;
}

function perLessonText(p) {
  const n = p.kind === 'single' ? 1 : (Number(p.lessonsCount) || 0);
  const amt = Number(p.amount);
  if (!n || p.amount === '' || Number.isNaN(amt)) {
    return `<span class="pl-idle">${p.kind === 'single' ? 'Enter what was paid.' : 'Enter both to see the per-lesson value.'}</span>`;
  }
  if (p.kind === 'single') {
    return `Covers <b>1 lesson</b> at ${money(amt)}. This is what that lesson will be worth.`;
  }
  const each = amt / n;
  const rate = studentModal ? Number(studentModal.rate) : 0;
  let tag = '';
  if (rate > 0) {
    const diff = rate - each;
    if (diff > 0.005) tag = ` <span class="pl-tag">${money(diff)} off the ${money(rate)} rate</span>`;
    else if (diff < -0.005) tag = ` <span class="pl-tag">${money(-diff)} above the ${money(rate)} rate</span>`;
  }
  return `<b>${money(each)}</b> per lesson${tag} — that's what each covered lesson is worth.`;
}

function confirmModalHTML() {
  return `<div class="ov top" data-ov="confirm"><div class="sheet narrow">
    <p class="cmsg">${esc(confirmModal.message)}</p>
    <div class="acts">
      <button class="btn grow" data-a="cancel-confirm">Cancel</button>
      <button class="btn ${confirmModal.type === 'settle' ? 'pri' : 'dang'} grow" data-a="do-confirm">${esc(confirmModal.verb || 'Delete')}</button>
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

function saveCur() {
  const f = curForm;
  if (!f.studentId || !f.time) return;
  const body = JSON.stringify({
    studentId: f.studentId, weekday: Number(f.weekday), time: f.time,
    duration: Number(f.duration), subject: f.subject, amount: Number(f.amount),
  });
  const id = f.id;
  curForm = null;
  mutate(id ? ('/curriculum/' + id) : '/curriculum', { method: id ? 'PUT' : 'POST', body });
}

async function savePrepay() {
  const f = studentModal, p = prepayForm;
  const okCount = p.kind === 'single' ? true : Number(p.lessonsCount) > 0;
  if (!p || !okCount || p.amount === '' || Number.isNaN(Number(p.amount))) return;
  const id = f.id;
  const count = p.kind === 'single' ? 1 : Number(p.lessonsCount);
  const body = JSON.stringify({ lessonsCount: count, amount: Number(p.amount), date: p.date, kind: p.kind });
  const isEdit = !!p.id;
  prepayForm = null;
  await mutate(isEdit ? ('/payments/' + p.id) : ('/students/' + id + '/prepayments'), {
    method: isEdit ? 'PUT' : 'POST',
    body,
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
  else if (c.type === 'settle') {
    const sid = c.id;
    await mutate('/students/' + sid + '/settle', { method: 'POST' });
    const fresh = studentById(sid);
    if (fresh && studentModal) { studentModal = { ...fresh }; render(); }
  }
  else if (c.type === 'curriculum') { curForm = null; await mutate('/curriculum/' + c.id, { method: 'DELETE' }); }
  else if (c.type === 'reset') { await mutate('/reset', { method: 'POST' }); }
}

// ---------- Events ----------
document.addEventListener('click', (e) => {
  if (justDragged) { justDragged = false; return; }
  const ov = e.target.closest('.ov');
  if (ov && e.target === ov) {
    if (ov.dataset.ov === 'confirm') confirmModal = null;
    else if (ov.dataset.ov === 'lesson') lessonModal = null;
    else if (ov.dataset.ov === 'cur') curForm = null;
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
    case 'pick-date':
      state.selectedDate = v;
      state.weekStart = mondayOf(parseISO(v));
      render(); break;
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
      prepayForm = { id: null, kind: 'prepaid', lessonsCount: '', amount: '', date: todayISO() };
      render(); break;
    case 'pp-kind':
      prepayForm.kind = v;
      if (v === 'single') prepayForm.lessonsCount = 1;
      else if (prepayForm.lessonsCount === 1) prepayForm.lessonsCount = '';
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
    case 'settle': {
      const st = studentById(id);
      const owed = state.lessons.filter(l => l.studentId === id && l.status === 'completed' && !l.paid);
      const sum = owed.reduce((x, l) => x + value(l), 0);
      confirmModal = {
        type: 'settle', id,
        message: `Mark all ${owed.length} unpaid lesson${owed.length === 1 ? '' : 's'} for ${st ? st.name : 'this student'} as paid? That's ${money(sum)}.`,
        verb: 'Mark paid',
      };
      render(); break;
    }
    case 'see-student':
      state.filterStudent = id;
      state.filterPaid = 'unpaid';
      state.filterStatus = 'all';
      state.tab = 'lessons';
      render(); break;
    case 'new-cur': {
      const st0 = state.students[0];
      if (!st0) { state.tab = 'students'; openNewStudent(); break; }
      curForm = {
        id: null, studentId: st0.id,
        weekday: v != null && v !== '' ? Number(v) : (new Date().getDay() + 6) % 7,
        time: el.dataset.t || '15:00', duration: 60, subject: st0.subject, amount: st0.rate,
      };
      render(); break;
    }
    case 'edit-cur': {
      const c = state.curriculum.find(x => x.id === id);
      if (c) { curForm = { ...c }; render(); }
      break;
    }
    case 'open-cur-from-lesson': {
      const c = state.curriculum.find(x => x.id === id);
      lessonModal = null;
      state.tab = 'curriculum';
      if (c) curForm = { ...c };
      render(); break;
    }
    case 'close-cur': curForm = null; render(); break;
    case 'save-cur': saveCur(); break;
    case 'ask-del-cur':
      confirmModal = {
        type: 'curriculum', id: curForm.id,
        message: 'Remove this from your weekly curriculum? Upcoming lessons from it are cleared; past and paid ones stay.',
        verb: 'Remove slot',
      };
      render(); break;
    case 'wk':
      state.weekStart = addDays(state.weekStart, 7 * Number(v));
      render(); break;
    case 'wk-today':
      state.weekStart = mondayOf(new Date());
      render(); break;
    case 'slot': {
      // Book straight into the clicked hour.
      if (!state.students.length) { state.tab = 'students'; openNewStudent(); break; }
      const st0 = state.students[0];
      lessonModal = {
        id: null, studentId: st0.id, date: v, time: el.dataset.t, duration: 60,
        subject: st0.subject, amount: st0.rate, status: statusForDate(v),
        paidCash: false, viaPrepay: false, notes: '', extra: [],
      };
      render(); break;
    }
    case 'quick-done': {
      const l = lessonById(id);
      if (!l) break;
      mutate('/lessons/' + id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: l.status === 'completed' ? 'scheduled' : 'completed' }),
      });
      break;
    }
    case 'quick-paid': mutate('/lessons/' + id + '/paid', { method: 'PATCH' }); break;
    case 'chart-mode': state.chartMode = v; render(); break;
    case 'sel-start': state.selecting = true; state.selected = {}; render(); break;
    case 'sel-cancel': state.selecting = false; state.selected = {}; render(); break;
    case 'toggle-sel':
      state.selected[id] = !state.selected[id];
      render(); break;
    case 'sel-all': {
      const ids = (v || '').split(',').filter(Boolean);
      const allOn = ids.every(x => state.selected[x]);
      ids.forEach(x => { state.selected[x] = !allOn; });
      render(); break;
    }
    case 'sel-pay':
    case 'sel-unpay': {
      const ids = Object.keys(state.selected).filter(k => state.selected[k]);
      if (!ids.length) break;
      state.selecting = false; state.selected = {};
      mutate('/lessons/bulk-paid', { method: 'POST', body: JSON.stringify({ ids, paidCash: a === 'sel-pay' }) });
      break;
    }
    case 'edit-prepay': {
      const pay = state.payments.find(x => x.id === id);
      if (pay) {
        prepayForm = { id: pay.id, kind: pay.kind || 'prepaid', lessonsCount: pay.lessonsCount, amount: pay.amount, date: pay.date };
        render();
      }
      break;
    }
    case 'ask-settle': {
      const st = studentById(id);
      const owed = state.lessons.filter(l => l.studentId === id && l.status === 'completed' && !l.paid);
      const sum = owed.reduce((x, l) => x + value(l), 0);
      confirmModal = {
        type: 'settle', id,
        message: `Mark all ${owed.length} unpaid lesson${owed.length === 1 ? '' : 's'} for ${st ? st.name : 'this student'} as paid? That's ${money(sum)}.`,
        verb: 'Mark paid',
      };
      render(); break;
    }
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
      // Deliberately does not touch prepayForm — a recorded block keeps
      // whatever was actually paid, discount included.
      return;
    }
  }
  if (curForm) {
    if (f === 'curTime') { curForm.time = e.target.value; return; }
    if (f === 'curDuration') { curForm.duration = Number(e.target.value) || 0; return; }
    if (f === 'curAmount') { curForm.amount = Number(e.target.value) || 0; return; }
  }
  if (prepayForm) {
    // Both fields are exactly what you type. Nothing is derived, so a
    // discounted block (8 lessons for 180) records as-is.
    if (f === 'ppCount') { prepayForm.lessonsCount = e.target.value; refreshPerLesson(); return; }
    if (f === 'ppAmount') { prepayForm.amount = e.target.value; refreshPerLesson(); return; }
    if (f === 'ppDate') { prepayForm.date = e.target.value; return; }
  }
});

function refreshPerLesson() {
  const el = document.getElementById('perLesson');
  if (el && prepayForm) el.innerHTML = perLessonText(prepayForm);
}

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
  if (curForm) {
    if (f === 'curStudent') {
      curForm.studentId = e.target.value;
      const st = studentById(e.target.value);
      if (st) { curForm.subject = st.subject; curForm.amount = Number((st.rate * (curForm.duration / 60)).toFixed(2)); }
      render(); return;
    }
    if (f === 'curWeekday') { curForm.weekday = Number(e.target.value); return; }
    if (f === 'curSubject') { curForm.subject = e.target.value; return; }
  }
  if (lessonModal && f === 'subject') { lessonModal.subject = e.target.value; return; }
  if (studentModal && f === 'subject') { studentModal.subject = e.target.value; return; }
});

// ---------- Drag and drop ----------
// Pointer events rather than HTML5 drag, so this works the same with a mouse
// and a finger. A press that doesn't move is left alone and becomes a click.
const SNAP = 15;            // minutes
const DRAG_THRESHOLD = 6;   // px before a press counts as a drag
let drag = null;
let justDragged = false;

function gridGeometry(grid) {
  const cols = [...grid.querySelectorAll('.wk-col')];
  return {
    cols,
    rects: cols.map(c => c.getBoundingClientRect()),
    from: Number(grid.dataset.from),
    to: Number(grid.dataset.to),
    kind: grid.dataset.grid,
  };
}

function dropTarget(g, clientX, topY, dur) {
  // Nearest column horizontally, clamped to the grid.
  let idx = g.rects.findIndex(r => clientX >= r.left && clientX <= r.right);
  if (idx === -1) {
    let best = 0, bestD = Infinity;
    g.rects.forEach((r, i) => {
      const d = clientX < r.left ? r.left - clientX : clientX - r.right;
      if (d < bestD) { bestD = d; best = i; }
    });
    idx = best;
  }
  const r = g.rects[idx];
  const raw = g.from + ((topY - r.top) / SLOT_H) * 60;
  let mins = Math.round(raw / SNAP) * SNAP;
  mins = Math.max(g.from, Math.min(mins, g.to - dur));
  return { idx, mins };
}

document.addEventListener('pointerdown', (e) => {
  if (state.selecting || e.button > 0) return;
  if (e.target.closest('.wk-act')) return;   // quick buttons aren't drag handles
  const b = e.target.closest('.wk-b.drg');
  if (!b) return;
  const grid = b.closest('.wk');
  if (!grid) return;
  const rect = b.getBoundingClientRect();
  drag = {
    el: b, grid,
    id: b.dataset.id,
    dur: Number(b.dataset.dur) || 60,
    startMins: Number(b.dataset.start),
    startX: e.clientX, startY: e.clientY,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    w: rect.width, h: rect.height,
    active: false, target: null, ghost: null, geo: null,
  };
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.geo = gridGeometry(drag.grid);
    drag.el.classList.add('drag-float');
    drag.el.style.width = drag.w + 'px';
    drag.el.style.height = drag.h + 'px';
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'drop-ghost';
    drag.ghost.style.height = drag.h + 'px';
    document.body.classList.add('dragging');
  }
  e.preventDefault();
  drag.el.style.left = (e.clientX - drag.grabX) + 'px';
  drag.el.style.top = (e.clientY - drag.grabY) + 'px';

  const t = dropTarget(drag.geo, e.clientX, e.clientY - drag.grabY, drag.dur);
  drag.target = t;
  const col = drag.geo.cols[t.idx];
  drag.ghost.style.top = (((t.mins - drag.geo.from) / 60) * SLOT_H) + 'px';
  drag.ghost.textContent = clockLabel(t.mins);
  if (drag.ghost.parentNode !== col) col.appendChild(drag.ghost);
}, { passive: false });

document.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return;             // a plain click; the click handler takes it

  // Swallow the click that follows the release, but never leave the flag
  // stuck if no click arrives (e.g. released over empty space).
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 60);

  if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
  document.body.classList.remove('dragging');
  // No need to unpick the inline styles: every path below re-renders.

  const t = d.target;
  if (!t) { render(); return; }

  const col = d.geo.cols[t.idx];
  if (d.geo.kind === 'cur') {
    const wd = Number(col.dataset.wd);
    const time = clockLabel(t.mins);
    const before = state.curriculum.find(c => c.id === d.id);
    if (before && before.weekday === wd && before.time === time) { render(); return; }
    mutate('/curriculum/' + d.id + '/move', { method: 'PATCH', body: JSON.stringify({ weekday: wd, time }) });
  } else {
    // Past midnight belongs to the following date.
    const past = t.mins >= 1440;
    const date = past ? col.dataset.next : col.dataset.date;
    const time = clockLabel(t.mins);
    const before = lessonById(d.id);
    if (before && before.date === date && before.time === time) { render(); return; }
    mutate('/lessons/' + d.id + '/move', { method: 'PATCH', body: JSON.stringify({ date, time }) });
  }
});

document.addEventListener('pointercancel', () => {
  if (drag && drag.active) {
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    document.body.classList.remove('dragging');
    drag = null;
    render();
  } else { drag = null; }
});

// Nudge the current-time marker along. Skipped while dragging or with a sheet
// open, so nothing under the cursor or a half-typed field gets rebuilt.
setInterval(() => {
  if (!state.loaded || state.tab !== 'calendar' || !WIDE()) return;
  if (drag || lessonModal || studentModal || curForm || confirmModal) return;
  render();
}, 60000);

// Swap between month-with-dots and the week grid when the window crosses
// the breakpoint (e.g. rotating a tablet, or resizing on desktop).
(function watchWidth() {
  const mq = window.matchMedia('(min-width: 860px)');
  const on = () => { if (state.loaded) render(); };
  if (mq.addEventListener) mq.addEventListener('change', on);
  else if (mq.addListener) mq.addListener(on);
})();

// ---------- Init ----------
(async function init() {
  render();
  try {
    const data = await call('/state');
    state.students = data.students;
    state.lessons = data.lessons;
    state.payments = data.payments;
    state.curriculum = data.curriculum || [];
  } catch (e) {
    state.error = 'Could not reach the server.';
  }
  state.loaded = true;
  render();
})();
