const crypto = require('crypto');

// One-way sync: Pamoka lessons -> a Google Calendar event. Never the reverse.
// Recomputed the same way reconcileStudent() is in server.js: every mutation
// re-pushes current lesson data rather than tracking what changed, so it
// can't drift even if a sync is missed or the app restarts mid-flight.

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SYNC_HORIZON_DAYS = 70;
const SYNC_LOOKBACK_DAYS = 7;

let cachedToken = null; // { token, expiresAt }
let pendingState = null; // in-memory CSRF guard for the one-time auth handshake

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

async function getSetting(pool, key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function setSetting(pool, key, value) {
  await pool.query(
    'INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
    [key, value]
  );
}

function getAuthUrl() {
  // TEMPORARY DEBUG — remove once the invalid_client issue is resolved.
  console.log('DEBUG client_id:', JSON.stringify(process.env.GOOGLE_CLIENT_ID));
  console.log('DEBUG redirect_uri:', JSON.stringify(process.env.GOOGLE_REDIRECT_URI));
  pendingState = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state: pendingState,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(pool, code, state) {
  if (!state || state !== pendingState) throw new Error('Auth link expired — start again from /auth/google');
  pendingState = null;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed');
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke Pamoka\'s access at myaccount.google.com/permissions and try again.');
  }
  await setSetting(pool, 'google_refresh_token', data.refresh_token);
}

async function getAccessToken(pool) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.token;
  const refreshToken = await getSetting(pool, 'google_refresh_token');
  if (!refreshToken) throw new Error('Google Calendar not connected — visit /auth/google');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token refresh failed');
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function apiRequest(pool, method, path, body) {
  const token = await getAccessToken(pool);
  const res = await fetch(CAL_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Google API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Lessons can run past midnight, so the end time is computed by wall-clock
// date arithmetic (same approach as the week grid) rather than string math.
function endDateTime(date, time, duration) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const dt = new Date(y, m - 1, d, h, min);
  dt.setMinutes(dt.getMinutes() + duration);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
}

function buildEventBody(l) {
  return {
    summary: `${l.student_name} – ${l.subject}`,
    start: { dateTime: `${l.date}T${l.time}:00`, timeZone: 'Europe/Vilnius' },
    end: { dateTime: endDateTime(l.date, l.time, l.duration), timeZone: 'Europe/Vilnius' },
  };
}

async function upsertEvent(pool, l) {
  const body = buildEventBody(l);
  if (l.google_event_id) {
    try {
      await apiRequest(pool, 'PATCH', `/events/${l.google_event_id}`, body);
      return l.google_event_id;
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
      // Event was deleted on the Google side — fall through and recreate it.
    }
  }
  const created = await apiRequest(pool, 'POST', '/events', body);
  return created.id;
}

async function deleteEvent(pool, eventId) {
  if (!eventId || !isConfigured()) return;
  try {
    await apiRequest(pool, 'DELETE', `/events/${eventId}`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) console.error('Google Calendar delete failed:', e.message);
  }
}

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Re-pushes every active lesson in the window and drops events for anything
// cancelled. Safe to call repeatedly; a missed or failed call just gets
// caught up by the next one.
async function syncWindow(pool) {
  if (!isConfigured()) return;
  const refreshToken = await getSetting(pool, 'google_refresh_token');
  if (!refreshToken) return;

  const today = new Date();
  const from = isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - SYNC_LOOKBACK_DAYS));
  const to = isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + SYNC_HORIZON_DAYS));

  const { rows: active } = await pool.query(
    `SELECT l.id, l.date, l.time, l.duration, l.subject, l.google_event_id, s.name AS student_name
     FROM lessons l JOIN students s ON s.id = l.student_id
     WHERE l.status IN ('scheduled','completed') AND l.date BETWEEN $1 AND $2`,
    [from, to]
  );
  for (const l of active) {
    try {
      const eventId = await upsertEvent(pool, l);
      if (eventId !== l.google_event_id) {
        await pool.query('UPDATE lessons SET google_event_id=$1 WHERE id=$2', [eventId, l.id]);
      }
    } catch (e) {
      console.error('Google Calendar sync failed for lesson', l.id, e.message);
    }
  }

  const { rows: cancelled } = await pool.query(
    `SELECT id, google_event_id FROM lessons WHERE status='cancelled' AND google_event_id IS NOT NULL`
  );
  for (const l of cancelled) {
    await deleteEvent(pool, l.google_event_id);
    await pool.query('UPDATE lessons SET google_event_id=NULL WHERE id=$1', [l.id]);
  }
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, syncWindow, deleteEvent };
