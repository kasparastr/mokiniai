// ---------- State ----------
let state = {
  students: [],
  lessons: [],
  payments: [],
  tab: 'overview',
  loaded: false,
  calendarMonth: new Date(),
  selectedDate: todayISO(),
  filterStatus: 'all',
  filterPaid: 'all',
  saveError: false,
};
let lessonModal = null;
let studentModal = null;
let confirmModal = null;
let prepayForm = null;

const SUBJECT_OPTIONS = ['Mathematics', 'Economics', 'Other'];
const STUDENT_COLORS = ['#2F6B4F', '#8B4A2B', '#3B5A6B', '#7A5C2E', '#6B3F5C', '#4A6B3F', '#8B3A3A', '#3F5C6B'];
const STATUS_LABELS = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled' };
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- Date helpers ----------
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO() { return toISODate(new Date()); }
function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function formatMonthLabel(d) {
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function getMonthGrid(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------- API ----------
async function api(path, options) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error('Request failed: ' + path);
  return res.json();
}
const Api = {
  getStudents: () => api('/students'),
  createStudent: (data) => api('/students', { method: 'POST', body: JSON.stringify(data) }),
  updateStudent: (id, data) => api('/students/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStudent: (id) => api('/students/' + id, { method: 'DELETE' }),
  getPayments: () => api('/payments'),
  addPrepayment: (studentId, data) => api('/students/' + studentId + '/prepayments', { method: 'POST', body: JSON.stringify(data) }),
  getLessons: () => api('/lessons'),
  createLesson: (data) => api('/lessons', { method: 'POST', body: JSON.stringify(data) }),
  updateLesson: (id, data) => api('/lessons/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  togglePaid: (id) => api('/lessons/' + id + '/paid', { method: 'PATCH' }),
  useLessonPrepay: (id) => api('/lessons/' + id + '/use-prepay', { method: 'PATCH' }),
  deleteLesson: (id) => api('/lessons/' + id, { method: 'DELETE' }),
};

// ---------- Derived data ----------
function studentById(id) { return state.students.find(s => s.id === id) || null; }
function studentPrepayBalance(id) {
  const s = studentById(id);
  return s ? (s.prepaidBalance || 0) : 0;
}
function lessonsByDate() {
  const m = {};
  state.lessons.forEach(l => { (m[l.date] = m[l.date] || []).push(l); });
  Object.values(m).forEach(arr => arr.sort((a, b) => a.time.localeCompare(b.time)));
  return m;
}
function computeStats() {
  const now = new Date();
  const curMonth = now.getMonth(), curYear = now.getFullYear();
  const today = todayISO();
  let monthIncome = 0, outstanding = 0, upcoming = 0, completedThisMonth = 0;
  state.lessons.forEach(l => {
    const [y, m] = l.date.split('-').map(Number);
    const inCurMonth = (y === curYear && (m - 1) === curMonth);
    if (l.paid && !l.viaPrepay && inCurMonth) monthIncome += Number(l.amount) || 0;
    if (l.status === 'completed' && !l.paid) outstanding += Number(l.amount) || 0;
    if (l.status === 'scheduled' && l.date >= today) upcoming += 1;
    if (l.status === 'completed' && inCurMonth) completedThisMonth += 1;
  });
  state.payments.forEach(p => {
    const [y, m] = p.date.split('-').map(Number);
    const inCurMonth = (y === curYear && (m - 1) === curMonth);
    if (inCurMonth) monthIncome += Number(p.amount) || 0;
  });
  const totalPrepaid = state.students.reduce((sum, s) => sum + (s.prepaidBalance || 0), 0);
  return { monthIncome, outstanding, upcoming, completedThisMonth, totalPrepaid };
}
function computeNextLesson() {
  const today = todayISO();
  const nowTime = new Date().toTimeString().slice(0, 5);
  const upcoming = state.lessons
    .filter(l => l.status === 'scheduled')
    .filter(l => l.date > today || (l.date === today && l.time >= nowTime))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return upcoming[0] || null;
}
function computeNeedsAttention() {
  return state.lessons.filter(l => l.status === 'completed' && !l.paid)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- Icons ----------
function iconHome() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>'; }
function iconCalendar() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'; }
function iconList() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'; }
function iconUsers(size) { return `<svg width="${size || 20}" height="${size || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`; }
function iconClock() { return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'; }
function iconChevronLeft() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>'; }
function iconChevronRight() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'; }
function iconTrash() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>'; }
function iconX() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'; }
function iconCheck() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline;vertical-align:-3px;"><path d="M20 6L9 17l-5-5"/></svg>'; }
function iconPlus(size) { return `<svg width="${size || 26}" height="${size || 26}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`; }

// ---------- Rendering ----------
function render() {
  const app = document.getElementById('app');
  if (!state.loaded) {
    app.innerHTML = '<div class="loading-screen">Loading…</div>';
    return;
  }
  app.innerHTML = `
    ${renderHeader()}
    <main>${renderTabContent()}</main>
    ${state.tab !== 'students' ? `<button class="fab" data-action="new-lesson" aria-label="Add lesson">${iconPlus()}</button>` : ''}
    ${renderNav()}
    ${lessonModal ? renderLessonModal() : ''}
    ${studentModal ? renderStudentModal() : ''}
    ${confirmModal ? renderConfirmModal() : ''}
  `;
}

function renderHeader() {
  return `
    <header class="app-header">
      <div class="app-header-inner">
        <div>
          <h1 class="app-title">Tutoring</h1>
          <p class="app-subtitle">${state.students.length} student${state.students.length !== 1 ? 's' : ''} · ${state.lessons.length} lesson${state.lessons.length !== 1 ? 's' : ''} on record</p>
        </div>
        ${state.saveError ? '<div class="save-badge">Connection issue</div>' : ''}
      </div>
      <div class="rule-double"></div>
      <div class="rule-double"></div>
    </header>
  `;
}

function renderNav() {
  const tabs = [
    { id: 'overview', label: 'Overview', icon: iconHome() },
    { id: 'calendar', label: 'Calendar', icon: iconCalendar() },
    { id: 'lessons', label: 'Lessons', icon: iconList() },
    { id: 'students', label: 'Students', icon: iconUsers() },
  ];
  return `
    <nav class="bottom-nav">
      ${tabs.map(t => `
        <button class="nav-btn ${state.tab === t.id ? 'active' : ''}" data-action="set-tab" data-tab="${t.id}">
          ${t.icon}<span>${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function renderTabContent() {
  if (state.tab === 'overview') return renderOverview();
  if (state.tab === 'calendar') return renderCalendar();
  if (state.tab === 'lessons') return renderLessons();
  if (state.tab === 'students') return renderStudents();
  return '';
}

function renderOverview() {
  if (state.students.length === 0) {
    return `
      <div class="view">
        <div class="empty-state">
          ${iconUsers(36)}
          <h2>Add your first student</h2>
          <p>You need a student on record before logging lessons.</p>
          <button class="btn btn-primary" data-action="new-student">Add student</button>
        </div>
      </div>
    `;
  }
  const stats = computeStats();
  const monthName = new Date().toLocaleDateString('en-GB', { month: 'long' });
  const nextLesson = computeNextLesson();
  const needsAttention = computeNeedsAttention();

  return `
    <div class="view">
      <div class="statement">
        <div class="statement-head"><h2>This month</h2><span>${monthName}</span></div>
        <div class="statement-row"><span>Received</span><span class="amount green">€${stats.monthIncome.toFixed(2)}</span></div>
        <div class="statement-row divider"><span>Outstanding</span><span class="amount rust">€${stats.outstanding.toFixed(2)}</span></div>
        <div class="statement-row"><span>Upcoming lessons</span><span class="count">${stats.upcoming}</span></div>
        <div class="statement-row"><span>Completed this month</span><span class="count">${stats.completedThisMonth}</span></div>
        <div class="statement-row"><span>Prepaid lessons on account</span><span class="count">${stats.totalPrepaid}</span></div>
      </div>
      ${nextLesson ? `<div style="margin-top:16px;"><p class="section-label">Next lesson</p>${lessonRowHTML(nextLesson)}</div>` : ''}
      ${needsAttention.length > 0 ? `<div style="margin-top:16px;"><p class="section-label">Needs payment</p>${needsAttention.slice(0, 5).map(lessonRowHTML).join('')}</div>` : ''}
      ${!nextLesson && needsAttention.length === 0 ? '<div class="empty-state" style="padding:32px 16px;"><p>All caught up. Tap + to log a lesson.</p></div>' : ''}
    </div>
  `;
}

function lessonRowHTML(l) {
  const s = studentById(l.studentId);
  const color = s ? s.color : '#a8a29e';
  const name = s ? esc(s.name) : 'Unknown student';
  return `
    <div class="lesson-row">
      <div class="lesson-color-bar" style="background:${color}"></div>
      <button class="lesson-main" data-action="open-lesson" data-id="${l.id}">
        <div class="lesson-top">
          <span class="lesson-name">${name}</span>
          <span class="status-badge status-${l.status}">${STATUS_LABELS[l.status]}</span>
        </div>
        <div class="lesson-meta">${iconClock()}<span>${formatDateLabel(l.date)} · ${esc(l.time)} · ${l.duration}min</span></div>
        <div class="lesson-subject">${esc(l.subject)}</div>
      </button>
      <button class="lesson-pay" data-action="toggle-paid" data-id="${l.id}">
        <span class="lesson-amount">€${Number(l.amount).toFixed(2)}</span>
        ${l.paid ? '<span class="stamp-paid">Paid</span>' : '<span class="tag-unpaid">Unpaid</span>'}
      </button>
    </div>
  `;
}

function renderCalendar() {
  const cells = getMonthGrid(state.calendarMonth);
  const byDate = lessonsByDate();
  const todayIso = todayISO();
  const dayLessons = byDate[state.selectedDate] || [];

  return `
    <div class="view">
      <div class="cal-header">
        <button data-action="cal-prev">${iconChevronLeft()}</button>
        <span class="cal-month">${formatMonthLabel(state.calendarMonth)}</span>
        <button data-action="cal-next">${iconChevronRight()}</button>
      </div>
      <div class="cal-grid">
        ${WEEKDAY_LABELS.map(d => `<div class="cal-weekday">${d}</div>`).join('')}
        ${cells.map(date => {
          if (!date) return '<div></div>';
          const iso = toISODate(date);
          const dayL = byDate[iso] || [];
          const isToday = iso === todayIso;
          const isSelected = iso === state.selectedDate;
          const cls = isSelected ? 'selected' : (isToday ? 'today' : '');
          const dots = dayL.slice(0, 3).map(l => {
            const s = studentById(l.studentId);
            const c = isSelected ? '#fff' : (s ? s.color : '#a8a29e');
            return `<span class="dot" style="background:${c}"></span>`;
          }).join('');
          return `
            <button class="cal-day ${cls}" data-action="select-date" data-date="${iso}">
              <span>${date.getDate()}</span>
              ${dayL.length ? `<div class="dots">${dots}</div>` : ''}
            </button>
          `;
        }).join('')}
      </div>
      <div class="cal-day-detail">
        <div class="cal-day-detail-head">
          <h3>${formatDateLabel(state.selectedDate)}</h3>
          <button class="btn-link" data-action="new-lesson-on-date">${iconPlus(14)} Add</button>
        </div>
        ${dayLessons.length === 0 ? '<p style="text-align:center;color:var(--ink-faint);font-size:14px;padding:16px 0;">No lessons this day.</p>' : dayLessons.map(lessonRowHTML).join('')}
      </div>
    </div>
  `;
}

function renderLessons() {
  const today = todayISO();
  const filtered = state.lessons.filter(l => {
    if (state.filterStatus !== 'all' && l.status !== state.filterStatus) return false;
    if (state.filterPaid === 'paid' && !l.paid) return false;
    if (state.filterPaid === 'unpaid' && l.paid) return false;
    return true;
  });
  const upcoming = filtered.filter(l => l.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = filtered.filter(l => l.date < today).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const chip = (label, active, action, value) => `<button class="filter-chip ${active ? 'active' : ''}" data-action="${action}" data-value="${value}">${label}</button>`;

  return `
    <div class="view">
      <div class="filter-row">
        ${chip('All', state.filterStatus === 'all', 'filter-status', 'all')}
        ${chip('Scheduled', state.filterStatus === 'scheduled', 'filter-status', 'scheduled')}
        ${chip('Completed', state.filterStatus === 'completed', 'filter-status', 'completed')}
        ${chip('Cancelled', state.filterStatus === 'cancelled', 'filter-status', 'cancelled')}
        <div class="filter-divider"></div>
        ${chip('Unpaid', state.filterPaid === 'unpaid', 'filter-paid', 'unpaid')}
        ${chip('Paid', state.filterPaid === 'paid', 'filter-paid', 'paid')}
      </div>
      ${upcoming.length ? `<p class="section-label">Upcoming</p>${upcoming.map(lessonRowHTML).join('')}` : ''}
      <p class="section-label" style="margin-top:${upcoming.length ? '20px' : '0'};">History</p>
      ${past.length === 0 ? '<p style="text-align:center;color:var(--ink-faint);font-size:14px;padding:16px 0;">No past lessons yet.</p>' : past.map(lessonRowHTML).join('')}
    </div>
  `;
}

function renderStudents() {
  return `
    <div class="view">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="font-size:14px;font-weight:600;margin:0;">Students</h2>
        <button class="btn-link" data-action="new-student">${iconPlus(14)} Add student</button>
      </div>
      ${state.students.length === 0 ? '<p style="text-align:center;color:var(--ink-faint);font-size:14px;padding:32px 0;">No students yet.</p>' : state.students.map(s => {
        const sl = state.lessons.filter(l => l.studentId === s.id);
        const completed = sl.filter(l => l.status === 'completed').length;
        const owed = sl.filter(l => l.status === 'completed' && !l.paid).reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
        const bits = [esc(s.subject)];
        if (s.grade) bits.push(esc(s.grade));
        bits.push(`€${s.rate}/hr`);
        bits.push(`${completed} lesson${completed !== 1 ? 's' : ''}`);
        if (owed > 0) bits.push(`€${owed.toFixed(2)} owed`);
        if (s.prepaidBalance > 0) bits.push(`${s.prepaidBalance} prepaid`);
        return `
          <div class="student-row">
            <div class="student-avatar" style="background:${s.color}">${esc(s.name.charAt(0).toUpperCase())}</div>
            <button class="student-main" data-action="edit-student" data-id="${s.id}">
              <div class="student-name">${esc(s.name)}</div>
              <div class="student-sub">${bits.join(' · ')}</div>
            </button>
            <button class="icon-btn" data-action="delete-student" data-id="${s.id}">${iconTrash()}</button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ---------- Modals ----------
function renderLessonModal() {
  const f = lessonModal;
  const isNew = !f.id;
  const balance = studentPrepayBalance(f.studentId);
  return `
    <div class="modal-overlay" data-modal="lesson">
      <div class="modal-sheet">
        <div class="modal-head"><h2>${isNew ? 'New lesson' : 'Edit lesson'}</h2><button class="modal-close" data-action="close-lesson-modal">${iconX()}</button></div>
        <div class="field">
          <label>Student</label>
          <select data-field="studentId">
            ${state.students.map(s => `<option value="${s.id}" ${s.id === f.studentId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>Date</label><input type="date" data-field="date" value="${f.date}" /></div>
          <div class="field"><label>Time</label><input type="time" data-field="time" value="${f.time}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Duration (min)</label><input type="number" min="15" step="15" data-field="duration" value="${f.duration}" /></div>
          <div class="field"><label>Amount (€)</label><input type="number" min="0" step="0.5" data-field="amount" value="${f.amount}" /></div>
        </div>
        <div class="field">
          <label>Subject</label>
          <select data-field="subject">
            ${SUBJECT_OPTIONS.map(s => `<option value="${s}" ${s === f.subject ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        ${isNew ? `
          <div class="field">
            <label class="checkbox-label"><input type="checkbox" data-field="repeat" ${f.repeat ? 'checked' : ''} /> Repeat weekly</label>
          </div>
          ${f.repeat ? `
            <div class="field"><label>Number of weeks</label><input type="number" min="2" max="52" data-field="repeatWeeks" value="${f.repeatWeeks || 8}" /></div>
          ` : ''}
        ` : ''}
        <div class="field">
          <label>Status</label>
          <div class="status-picker">
            ${Object.keys(STATUS_LABELS).map(st => `<button type="button" class="status-option ${f.status === st ? 'active ' + st : ''}" data-action="set-status" data-value="${st}">${STATUS_LABELS[st]}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>Payment</label>
          <button type="button" class="paid-toggle ${f.paid ? 'is-paid' : 'is-unpaid'}" data-action="toggle-modal-paid">${f.paid ? iconCheck() + (f.viaPrepay ? ' Paid (prepay)' : ' Paid') : 'Unpaid'}</button>
          ${(!isNew && !f.paid && balance > 0) ? `<button type="button" class="btn-link" data-action="use-prepay-in-modal" style="margin-top:8px;">Use prepay credit (${balance} left)</button>` : ''}
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea data-field="notes" rows="2" placeholder="Optional">${esc(f.notes || '')}</textarea>
        </div>
        <div class="modal-actions">
          ${!isNew ? `<button class="btn btn-danger-outline" data-action="delete-lesson-from-modal">${iconTrash()}</button>` : ''}
          <button class="btn btn-secondary btn-flex" data-action="close-lesson-modal">Cancel</button>
          <button class="btn btn-primary btn-flex" data-action="save-lesson">Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderStudentModal() {
  const f = studentModal;
  return `
    <div class="modal-overlay" data-modal="student">
      <div class="modal-sheet">
        <div class="modal-head"><h2>${f.id ? 'Edit student' : 'New student'}</h2><button class="modal-close" data-action="close-student-modal">${iconX()}</button></div>
        <div class="field"><label>Name</label><input type="text" data-field="name" value="${esc(f.name)}" placeholder="Student name" /></div>
        <div class="field">
          <label>Subject</label>
          <select data-field="subject">
            ${SUBJECT_OPTIONS.map(s => `<option value="${s}" ${s === f.subject ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Grade</label><input type="text" data-field="grade" value="${esc(f.grade || '')}" placeholder="e.g. 10th grade" /></div>
        <div class="field"><label>Rate (€/hour)</label><input type="number" min="0" step="1" data-field="rate" value="${f.rate}" /></div>
        ${f.id ? renderPrepaySection(f) : ''}
        <div class="modal-actions">
          <button class="btn btn-secondary btn-flex" data-action="close-student-modal">Cancel</button>
          <button class="btn btn-primary btn-flex" data-action="save-student">Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderPrepaySection(f) {
  const balance = f.prepaidBalance || 0;
  return `
    <div class="prepay-box">
      <div class="prepay-row">
        <span>Prepaid lessons</span>
        <span class="prepay-balance">${balance} left</span>
      </div>
      ${prepayForm ? `
        <div class="field-row" style="margin-top:8px;">
          <div class="field"><label># lessons</label><input type="number" min="1" data-field="prepayLessons" value="${prepayForm.lessonsCount}" /></div>
          <div class="field"><label>Amount (€)</label><input type="number" min="0" step="0.5" data-field="prepayAmount" value="${prepayForm.amount}" /></div>
        </div>
        <div class="modal-actions" style="margin-top:0;">
          <button class="btn btn-secondary btn-flex" data-action="cancel-prepay">Cancel</button>
          <button class="btn btn-primary btn-flex" data-action="record-prepay">Record</button>
        </div>
      ` : `<button type="button" class="btn-link" data-action="open-prepay" style="margin-top:6px;">${iconPlus(14)} Add prepayment</button>`}
    </div>
  `;
}

function renderConfirmModal() {
  return `
    <div class="modal-overlay" data-modal="confirm" style="z-index:40;">
      <div class="modal-sheet" style="border-radius:12px;max-width:340px;">
        <p style="font-size:14px;margin:0 0 16px;">${esc(confirmModal.message)}</p>
        <div class="modal-actions" style="margin-top:0;">
          <button class="btn btn-secondary btn-flex" data-action="cancel-confirm">Cancel</button>
          <button class="btn btn-danger btn-flex" data-action="confirm-delete">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ---------- Actions ----------
async function loadAll() {
  try {
    const [students, lessons, payments] = await Promise.all([Api.getStudents(), Api.getLessons(), Api.getPayments()]);
    state.students = students;
    state.lessons = lessons;
    state.payments = payments;
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  state.loaded = true;
  render();
}

function openNewLesson(dateOverride) {
  if (state.students.length === 0) {
    state.tab = 'students';
    studentModal = { id: null, name: '', subject: SUBJECT_OPTIONS[0], grade: '', rate: 20 };
    render();
    return;
  }
  const s = state.students[0];
  lessonModal = {
    id: null, studentId: s.id, date: dateOverride || todayISO(), time: '15:00',
    duration: 60, subject: s.subject, amount: s.rate, status: 'scheduled', paid: false, notes: '',
    repeat: false, repeatWeeks: 8,
  };
  render();
}

async function saveLessonModal() {
  const f = lessonModal;
  if (!f.studentId || !f.date || !f.time) return;
  try {
    if (f.id) {
      const updated = await Api.updateLesson(f.id, f);
      state.lessons = state.lessons.map(l => (l.id === f.id ? updated : l));
    } else if (f.repeat && Number(f.repeatWeeks) > 1) {
      const [y, m, d] = f.date.split('-').map(Number);
      const baseDate = new Date(y, m - 1, d);
      const creates = [];
      for (let i = 0; i < Number(f.repeatWeeks); i++) {
        const dt = new Date(baseDate);
        dt.setDate(dt.getDate() + 7 * i);
        creates.push(Api.createLesson({ ...f, date: toISODate(dt) }));
      }
      const created = await Promise.all(creates);
      state.lessons = [...state.lessons, ...created];
    } else {
      const created = await Api.createLesson(f);
      state.lessons = [...state.lessons, created];
    }
    lessonModal = null;
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  render();
}

async function toggleLessonPaid(id) {
  try {
    const result = await Api.togglePaid(id);
    state.lessons = state.lessons.map(l => (l.id === id ? { ...l, paid: result.paid, viaPrepay: result.viaPrepay } : l));
    // Re-fetch students in case a prepay credit was refunded server-side.
    state.students = await Api.getStudents();
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  render();
}

async function useLessonPrepayFromModal() {
  if (!lessonModal || !lessonModal.id) return;
  try {
    const result = await Api.useLessonPrepay(lessonModal.id);
    state.lessons = state.lessons.map(l => (l.id === lessonModal.id ? { ...l, paid: true, viaPrepay: true } : l));
    state.students = state.students.map(s => (s.id === lessonModal.studentId ? { ...s, prepaidBalance: result.newBalance } : s));
    lessonModal.paid = true;
    lessonModal.viaPrepay = true;
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  render();
}

async function saveStudentModal() {
  const f = studentModal;
  if (!f.name || !f.name.trim()) return;
  try {
    if (f.id) {
      const updated = await Api.updateStudent(f.id, f);
      state.students = state.students.map(s => (s.id === f.id ? updated : s));
    } else {
      const color = STUDENT_COLORS[state.students.length % STUDENT_COLORS.length];
      const created = await Api.createStudent({ ...f, color });
      state.students = [...state.students, created];
    }
    studentModal = null;
    prepayForm = null;
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  render();
}

async function recordPrepayment() {
  if (!studentModal || !prepayForm) return;
  const lessonsCount = Number(prepayForm.lessonsCount);
  const amount = Number(prepayForm.amount);
  if (!lessonsCount || lessonsCount <= 0 || Number.isNaN(amount)) return;
  try {
    const result = await Api.addPrepayment(studentModal.id, { lessonsCount, amount });
    state.students = state.students.map(s => (s.id === studentModal.id ? result.student : s));
    state.payments = [result.payment, ...state.payments];
    studentModal.prepaidBalance = result.student.prepaidBalance;
    prepayForm = null;
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  render();
}

async function performConfirmedDelete() {
  const c = confirmModal;
  try {
    if (c.type === 'lesson') {
      await Api.deleteLesson(c.id);
      state.lessons = state.lessons.filter(l => l.id !== c.id);
      state.students = await Api.getStudents();
    } else {
      await Api.deleteStudent(c.id);
      state.students = state.students.filter(s => s.id !== c.id);
      state.lessons = state.lessons.filter(l => l.studentId !== c.id);
    }
    state.saveError = false;
  } catch (e) {
    console.error(e);
    state.saveError = true;
  }
  confirmModal = null;
  lessonModal = null;
  studentModal = null;
  render();
}

// ---------- Event delegation ----------
document.addEventListener('click', (e) => {
  const overlay = e.target.closest('.modal-overlay');
  if (overlay && e.target === overlay) {
    const which = overlay.dataset.modal;
    if (which === 'confirm') confirmModal = null;
    else if (which === 'lesson') lessonModal = null;
    else if (which === 'student') { studentModal = null; prepayForm = null; }
    render();
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'set-tab': state.tab = el.dataset.tab; render(); break;
    case 'new-lesson': openNewLesson(todayISO()); break;
    case 'new-lesson-on-date': openNewLesson(state.selectedDate); break;
    case 'new-student': studentModal = { id: null, name: '', subject: SUBJECT_OPTIONS[0], grade: '', rate: 20 }; render(); break;
    case 'edit-student': {
      const s = studentById(el.dataset.id);
      if (s) { studentModal = { ...s }; prepayForm = null; render(); }
      break;
    }
    case 'delete-student':
      confirmModal = { type: 'student', id: el.dataset.id, message: 'Delete this student? Their lessons will be deleted too.' };
      render();
      break;
    case 'open-lesson': {
      const l = state.lessons.find(x => x.id === el.dataset.id);
      if (l) { lessonModal = { ...l }; render(); }
      break;
    }
    case 'toggle-paid': toggleLessonPaid(el.dataset.id); break;
    case 'cal-prev': state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1); render(); break;
    case 'cal-next': state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1); render(); break;
    case 'select-date': state.selectedDate = el.dataset.date; render(); break;
    case 'filter-status': state.filterStatus = el.dataset.value; render(); break;
    case 'filter-paid': state.filterPaid = (state.filterPaid === el.dataset.value ? 'all' : el.dataset.value); render(); break;
    case 'close-lesson-modal': lessonModal = null; render(); break;
    case 'close-student-modal': studentModal = null; prepayForm = null; render(); break;
    case 'save-lesson': saveLessonModal(); break;
    case 'save-student': saveStudentModal(); break;
    case 'delete-lesson-from-modal':
      confirmModal = { type: 'lesson', id: lessonModal.id, message: 'Delete this lesson?' };
      render();
      break;
    case 'set-status': lessonModal.status = el.dataset.value; render(); break;
    case 'toggle-modal-paid': lessonModal.paid = !lessonModal.paid; lessonModal.viaPrepay = false; render(); break;
    case 'use-prepay-in-modal': useLessonPrepayFromModal(); break;
    case 'open-prepay': prepayForm = { lessonsCount: 1, amount: studentModal.rate }; render(); break;
    case 'cancel-prepay': prepayForm = null; render(); break;
    case 'record-prepay': recordPrepayment(); break;
    case 'cancel-confirm': confirmModal = null; render(); break;
    case 'confirm-delete': performConfirmedDelete(); break;
  }
});

// Continuous-typing fields: update state without a full re-render, so focus/cursor is preserved.
document.addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (!field || e.target.tagName === 'SELECT') return;

  if (lessonModal) {
    if (field === 'duration') {
      const mins = Number(e.target.value) || 0;
      lessonModal.duration = mins;
      const s = studentById(lessonModal.studentId);
      if (s) {
        lessonModal.amount = Number((s.rate * (mins / 60)).toFixed(2));
        const amountInput = document.querySelector('[data-field="amount"]');
        if (amountInput) amountInput.value = lessonModal.amount;
      }
      return;
    }
    if (field === 'amount') { lessonModal.amount = Number(e.target.value) || 0; return; }
    if (field === 'date') { lessonModal.date = e.target.value; return; }
    if (field === 'time') { lessonModal.time = e.target.value; return; }
    if (field === 'notes') { lessonModal.notes = e.target.value; return; }
    if (field === 'repeatWeeks') { lessonModal.repeatWeeks = Number(e.target.value) || 8; return; }
  }
  if (studentModal) {
    if (field === 'name') { studentModal.name = e.target.value; return; }
    if (field === 'grade') { studentModal.grade = e.target.value; return; }
    if (field === 'rate') { studentModal.rate = Number(e.target.value) || 0; return; }
  }
  if (prepayForm) {
    if (field === 'prepayLessons') { prepayForm.lessonsCount = Number(e.target.value) || 0; return; }
    if (field === 'prepayAmount') { prepayForm.amount = Number(e.target.value) || 0; return; }
  }
});

// Select + checkbox fields: discrete choice, full re-render is fine here.
document.addEventListener('change', (e) => {
  const field = e.target.dataset.field;
  if (!field) return;

  if (e.target.type === 'checkbox') {
    if (lessonModal && field === 'repeat') { lessonModal.repeat = e.target.checked; render(); }
    return;
  }
  if (e.target.tagName !== 'SELECT') return;

  if (lessonModal && field === 'studentId') {
    lessonModal.studentId = e.target.value;
    const s = studentById(e.target.value);
    if (s) {
      lessonModal.subject = s.subject;
      lessonModal.amount = Number((s.rate * (lessonModal.duration / 60)).toFixed(2));
    }
    render();
    return;
  }
  if (lessonModal && field === 'subject') { lessonModal.subject = e.target.value; return; }
  if (studentModal && field === 'subject') { studentModal.subject = e.target.value; return; }
});

// ---------- Init ----------
render();
loadAll();
