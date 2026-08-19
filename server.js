const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

// ---------- Optional password gate ----------
function basicAuth(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();
  const header = req.headers.authorization || '';
  const token = header.split(' ')[1] || '';
  let decoded = '';
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch (e) {
    decoded = '';
  }
  const idx = decoded.indexOf(':');
  const provided = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (provided === password) return next();
  res.set('WWW-Authenticate', 'Basic realm="Tutoring Tracker"');
  return res.status(401).send('Authentication required');
}
app.use(basicAuth);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/*
  PAYMENT MODEL
  -------------
  A lesson counts as paid if EITHER:
    - paid_cash  = true  (marked paid directly: cash, transfer, whatever)
    - via_prepay = true  (covered by a credit from a prepayment)

  via_prepay is never set by hand. After any change, reconcileStudent()
  recomputes it from scratch: take every completed lesson not already paid in
  cash, oldest first, and cover them while credits remain.

  Because it's recomputed rather than incremented, the balance can't drift and
  credits can't be orphaned. Cancel a lesson, delete one, or add a prepayment
  weeks after the fact, and everything re-settles correctly on its own.
*/

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      grade TEXT DEFAULT '',
      rate NUMERIC NOT NULL,
      color TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER NOT NULL,
      subject TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL,
      paid_cash BOOLEAN NOT NULL DEFAULT false,
      via_prepay BOOLEAN NOT NULL DEFAULT false,
      notes TEXT DEFAULT ''
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      lessons_count INTEGER NOT NULL,
      amount NUMERIC NOT NULL,
      notes TEXT DEFAULT ''
    );
  `);

  // Migrations for databases created by earlier versions.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS grade TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS via_prepay BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS paid_cash BOOLEAN NOT NULL DEFAULT false`);
  const hasOldPaid = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lessons' AND column_name = 'paid'
  `);
  if (hasOldPaid.rowCount > 0) {
    await pool.query(`UPDATE lessons SET paid_cash = true WHERE paid = true AND via_prepay = false`);
    await pool.query(`ALTER TABLE lessons ALTER COLUMN paid DROP NOT NULL`);
  }
  // prepaid_balance is no longer used; the balance is derived. Harmless if present.
}

// ---------- Reconciliation ----------
async function reconcileStudent(client, studentId) {
  if (!studentId) return;
  const creditsRes = await client.query(
    'SELECT COALESCE(SUM(lessons_count), 0) AS credits FROM payments WHERE student_id = $1',
    [studentId]
  );
  const credits = Number(creditsRes.rows[0].credits) || 0;

  const coverable = await client.query(
    `SELECT id FROM lessons
     WHERE student_id = $1 AND status = 'completed' AND paid_cash = false
     ORDER BY date ASC, time ASC`,
    [studentId]
  );
  const covered = coverable.rows.slice(0, credits).map(r => r.id);

  await client.query('UPDATE lessons SET via_prepay = false WHERE student_id = $1', [studentId]);
  if (covered.length) {
    await client.query('UPDATE lessons SET via_prepay = true WHERE id = ANY($1::text[])', [covered]);
  }
}

async function reconcileAll(client) {
  const { rows } = await client.query('SELECT id FROM students');
  for (const r of rows) await reconcileStudent(client, r.id);
}

// ---------- Serialization ----------
function mapStudent(r, creditsById, usedById) {
  const credits = creditsById[r.id] || 0;
  const used = usedById[r.id] || 0;
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    grade: r.grade || '',
    rate: Number(r.rate),
    color: r.color,
    creditsTotal: credits,
    creditsUsed: used,
    prepaidBalance: credits - used,
  };
}
function mapLesson(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    date: r.date,
    time: r.time,
    duration: r.duration,
    subject: r.subject,
    amount: Number(r.amount),
    status: r.status,
    paidCash: r.paid_cash,
    viaPrepay: r.via_prepay,
    paid: r.paid_cash || r.via_prepay,
    notes: r.notes || '',
  };
}
function mapPayment(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    date: r.date,
    lessonsCount: r.lessons_count,
    amount: Number(r.amount),
    notes: r.notes || '',
  };
}

// Every mutating endpoint returns the whole state, so the client can't drift
// out of sync with the server's allocation.
async function fullState(client) {
  // Sequential on purpose: inside a transaction these share one connection.
  const q = client || pool;
  const studentsRes = await q.query('SELECT * FROM students ORDER BY name');
  const lessonsRes = await q.query('SELECT * FROM lessons ORDER BY date, time');
  const paymentsRes = await q.query('SELECT * FROM payments ORDER BY date DESC');
  const creditsRes = await q.query('SELECT student_id, COALESCE(SUM(lessons_count),0) AS c FROM payments GROUP BY student_id');
  const usedRes = await q.query('SELECT student_id, COUNT(*) AS c FROM lessons WHERE via_prepay = true GROUP BY student_id');
  const creditsById = {};
  creditsRes.rows.forEach(r => { creditsById[r.student_id] = Number(r.c); });
  const usedById = {};
  usedRes.rows.forEach(r => { usedById[r.student_id] = Number(r.c); });

  return {
    students: studentsRes.rows.map(r => mapStudent(r, creditsById, usedById)),
    lessons: lessonsRes.rows.map(mapLesson),
    payments: paymentsRes.rows.map(mapPayment),
  };
}

// Runs a mutation in a transaction, reconciles, returns full state.
// fn returns the student id to reconcile, or null to reconcile everyone.
async function mutate(res, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentId = await fn(client);
    if (studentId) await reconcileStudent(client, studentId);
    else await reconcileAll(client);
    const state = await fullState(client);
    await client.query('COMMIT');
    res.json(state);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: e.message || 'Request failed' });
  } finally {
    client.release();
  }
}

// ---------- Read ----------
app.get('/api/state', async (req, res) => {
  try {
    res.json(await fullState());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// ---------- Students ----------
app.post('/api/students', (req, res) => {
  mutate(res, async (client) => {
    const { name, subject, grade, rate, color } = req.body;
    if (!name || !subject || rate == null || !color) throw new Error('Missing fields');
    const id = crypto.randomUUID();
    await client.query(
      'INSERT INTO students (id, name, subject, grade, rate, color) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, subject, grade || '', rate, color]
    );
    return id;
  });
});

app.put('/api/students/:id', (req, res) => {
  mutate(res, async (client) => {
    const { name, subject, grade, rate, color } = req.body;
    await client.query(
      'UPDATE students SET name=$1, subject=$2, grade=$3, rate=$4, color=$5 WHERE id=$6',
      [name, subject, grade || '', rate, color, req.params.id]
    );
    return req.params.id;
  });
});

app.delete('/api/students/:id', (req, res) => {
  mutate(res, async (client) => {
    await client.query('DELETE FROM students WHERE id=$1', [req.params.id]);
    return null;
  });
});

// ---------- Prepayments ----------
app.post('/api/students/:id/prepayments', (req, res) => {
  mutate(res, async (client) => {
    const { lessonsCount, amount, date, notes } = req.body;
    const count = Number(lessonsCount);
    if (!count || count <= 0) throw new Error('Lesson count must be at least 1');
    await client.query(
      'INSERT INTO payments (id, student_id, date, lessons_count, amount, notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [crypto.randomUUID(), req.params.id, date || new Date().toISOString().slice(0, 10), count, amount || 0, notes || '']
    );
    return req.params.id;
  });
});

app.delete('/api/payments/:id', (req, res) => {
  mutate(res, async (client) => {
    const { rows } = await client.query('DELETE FROM payments WHERE id=$1 RETURNING student_id', [req.params.id]);
    return rows[0] ? rows[0].student_id : null;
  });
});

// ---------- Lessons ----------
app.post('/api/lessons', (req, res) => {
  mutate(res, async (client) => {
    const { studentId, dates, date, time, duration, subject, amount, status, paidCash, notes } = req.body;
    const list = (Array.isArray(dates) && dates.length) ? dates : [date];
    if (!studentId || !list.length || !time) throw new Error('Missing fields');
    for (const d of list) {
      await client.query(
        `INSERT INTO lessons (id, student_id, date, time, duration, subject, amount, status, paid_cash, via_prepay, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`,
        [crypto.randomUUID(), studentId, d, time, duration, subject, amount, status, !!paidCash, notes || '']
      );
    }
    return studentId;
  });
});

app.put('/api/lessons/:id', (req, res) => {
  mutate(res, async (client) => {
    const { studentId, date, time, duration, subject, amount, status, paidCash, notes } = req.body;
    const prev = await client.query('SELECT student_id FROM lessons WHERE id=$1', [req.params.id]);
    await client.query(
      `UPDATE lessons SET student_id=$1, date=$2, time=$3, duration=$4, subject=$5,
       amount=$6, status=$7, paid_cash=$8, notes=$9 WHERE id=$10`,
      [studentId, date, time, duration, subject, amount, status, !!paidCash, notes || '', req.params.id]
    );
    if (prev.rows[0] && prev.rows[0].student_id !== studentId) {
      await reconcileStudent(client, prev.rows[0].student_id);
    }
    return studentId;
  });
});

// Toggles the manual paid flag. A lesson currently covered by prepay, when
// tapped, becomes unpaid — reconciliation then decides if a credit still
// reaches it.
app.patch('/api/lessons/:id/paid', (req, res) => {
  mutate(res, async (client) => {
    const { rows } = await client.query('SELECT * FROM lessons WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) throw new Error('Lesson not found');
    const lesson = rows[0];
    const nextCash = !(lesson.paid_cash || lesson.via_prepay);
    await client.query('UPDATE lessons SET paid_cash=$1 WHERE id=$2', [nextCash, req.params.id]);
    return lesson.student_id;
  });
});

app.delete('/api/lessons/:id', (req, res) => {
  mutate(res, async (client) => {
    const { rows } = await client.query('DELETE FROM lessons WHERE id=$1 RETURNING student_id', [req.params.id]);
    return rows[0] ? rows[0].student_id : null;
  });
});

// Bulk: mark every past scheduled lesson as completed.
app.post('/api/lessons/complete-past', (req, res) => {
  mutate(res, async (client) => {
    const today = new Date().toISOString().slice(0, 10);
    await client.query(`UPDATE lessons SET status='completed' WHERE status='scheduled' AND date < $1`, [today]);
    return null;
  });
});

app.post('/api/reset', (req, res) => {
  mutate(res, async (client) => {
    await client.query('TRUNCATE TABLE lessons, payments, students CASCADE');
    return null;
  });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Tutoring tracker running on port ${PORT}`)))
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
