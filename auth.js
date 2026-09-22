const crypto = require('crypto');

// Passwordless login, alongside the existing APP_PASSWORD gate rather than
// replacing it: visiting /login emails a one-time link to a single fixed
// address (LOGIN_EMAIL — there's only one user, so no email input, which
// also means this endpoint can be public without becoming a way to spam
// arbitrary inboxes). Clicking it sets a signed session cookie that lets
// requests skip the basic-auth prompt entirely.

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const SESSION_COOKIE = 'pamoka_session';

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.LOGIN_EMAIL && process.env.SESSION_SECRET);
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(value).digest('hex');
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function hasValidSession(req) {
  if (!process.env.SESSION_SECRET) return false;
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return false;
  const [expiresAt, sig] = raw.split('.');
  if (!expiresAt || !sig || sign(expiresAt) !== sig) return false;
  return Number(expiresAt) > Date.now();
}

function setSessionCookie(res) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const value = `${expiresAt}.${sign(String(expiresAt))}`;
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}; Path=/`);
}

async function requestLoginLink(pool, baseUrl) {
  if (!isConfigured()) throw new Error('Email login is not set up.');

  const { rows } = await pool.query('SELECT created_at FROM login_tokens ORDER BY created_at DESC LIMIT 1');
  if (rows[0] && Date.now() - Number(rows[0].created_at) < RESEND_COOLDOWN_MS) {
    throw new Error('A link was just sent — check your email (or wait a minute to request another).');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await pool.query(
    'INSERT INTO login_tokens (token, created_at, expires_at) VALUES ($1,$2,$3)',
    [token, now, now + TOKEN_TTL_MS]
  );

  const link = `${baseUrl}/login/verify?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Pamoka <onboarding@resend.dev>',
      to: process.env.LOGIN_EMAIL,
      subject: 'Your Pamoka login link',
      html: `<p>Click to log in — this link works once and expires in 15 minutes:</p><p><a href="${link}">${link}</a></p>`,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Failed to send email (${res.status})`);
  }
}

async function verifyToken(pool, token) {
  if (!token) return false;
  const { rows } = await pool.query('DELETE FROM login_tokens WHERE token=$1 RETURNING expires_at', [token]);
  if (!rows[0]) return false;
  return Number(rows[0].expires_at) > Date.now();
}

module.exports = { isConfigured, hasValidSession, setSessionCookie, requestLoginLink, verifyToken };
