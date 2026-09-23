const crypto = require('crypto');

// A second, much narrower login: one account per student, scoped to only
// that student's own data. Separate cookie and separate credentials from
// the tutor's own login — a student session carries a student id, and every
// /portal/* route re-checks it against that id, never against "logged in
// at all" the way the admin gate does.

const PORTAL_COOKIE = 'pamoka_portal';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Falls back to a process-local secret if SESSION_SECRET isn't set, so the
// portal still works without the email-login feature configured — sessions
// just don't survive a redeploy in that case, which is fine for a trial.
let fallbackSecret = null;
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!fallbackSecret) fallbackSecret = crypto.randomBytes(32).toString('hex');
  return fallbackSecret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeAccount(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
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

function getPortalStudentId(req) {
  const raw = parseCookies(req.headers.cookie)[PORTAL_COOKIE];
  if (!raw) return null;
  const [studentId, expiresAt, sig] = raw.split('.');
  if (!studentId || !expiresAt || !sig) return null;
  if (sign(`${studentId}.${expiresAt}`) !== sig) return null;
  if (Number(expiresAt) <= Date.now()) return null;
  return studentId;
}

function setPortalSessionCookie(res, studentId) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const value = `${studentId}.${expiresAt}.${sign(`${studentId}.${expiresAt}`)}`;
  res.setHeader('Set-Cookie',
    `${PORTAL_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}; Path=/`);
}

function clearPortalSessionCookie(res) {
  res.setHeader('Set-Cookie', `${PORTAL_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`);
}

module.exports = { makeAccount, verifyPassword, getPortalStudentId, setPortalSessionCookie, clearPortalSessionCookie };
