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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS curriculum (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER NOT NULL,
      subject TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      start_date TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    );
  `);
  // A skip is one week of one curriculum slot, deleted from the calendar.
  // It stops that single occurrence coming back, while the slot itself keeps
  // generating every other week.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS curriculum_skips (
      curriculum_id TEXT NOT NULL REFERENCES curriculum(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      PRIMARY KEY (curriculum_id, date)
    );
  `);
  await pool.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS curriculum_id TEXT`);
  // Which payment paid for this lesson. Set by reconciliation, never by hand.
  await pool.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS covered_by TEXT`);
  // 'prepaid' = a block bought up front, 'single' = one lesson paid for on its own.
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'prepaid'`);
  // The earlier per-lesson 'series' approach is superseded by the curriculum.
  await pool.query(`ALTER TABLE lessons DROP COLUMN IF EXISTS series_id`);
  await pool.query(`DROP TABLE IF EXISTS series CASCADE`);

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

// ---------- Curriculum ----------
// The curriculum is a generic week. Rather than modelling infinite recurrence,
// each slot keeps a rolling window of real lesson rows generated ahead, so
// every occurrence stays an ordinary, individually editable lesson.
const HORIZON_DAYS = 70;

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Materialise curriculum slots into real lessons across a rolling window.
// Existing lessons and skipped weeks are left untouched, so this is safe to
// run on every request.
async function syncCurriculum(client) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = isoOf(today);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);

  const { rows: items } = await client.query('SELECT * FROM curriculum WHERE active = true');
  if (!items.length) return;

  const { rows: existing } = await client.query(
    'SELECT curriculum_id, date FROM lessons WHERE curriculum_id IS NOT NULL AND date >= $1',
    [todayIso]
  );
  const have = new Set(existing.map(r => r.curriculum_id + '|' + r.date));

  const { rows: skipRows } = await client.query('SELECT curriculum_id, date FROM curriculum_skips');
  const skipped = new Set(skipRows.map(r => r.curriculum_id + '|' + r.date));

  for (const c of items) {
    const d = new Date(today);
    // Advance to the first matching weekday on or after today.
    const cur = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() + ((c.weekday - cur + 7) % 7));
    while (d <= horizon) {
      const iso = isoOf(d);
      const key = c.id + '|' + iso;
      if (iso >= c.start_date && !have.has(key) && !skipped.has(key)) {
        await client.query(
          `INSERT INTO lessons (id, student_id, date, time, duration, subject, amount, status, paid_cash, via_prepay, notes, curriculum_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',false,false,'',$8)`,
          [crypto.randomUUID(), c.student_id, iso, c.time, c.duration, c.subject, c.amount, c.id]
        );
      }
      d.setDate(d.getDate() + 7);
    }
  }
}

// ---------- Reconciliation ----------
async function reconcileStudent(client, studentId) {
  if (!studentId) return;

  // Payments are consumed oldest first, and each lesson remembers which
  // payment covered it. That's what lets a lesson be worth 85/4 rather than
  // some price typed on the lesson itself.
  const { rows: payments } = await client.query(
    'SELECT id, lessons_count FROM payments WHERE student_id = $1 ORDER BY date ASC, id ASC',
    [studentId]
  );
  const { rows: coverable } = await client.query(
    `SELECT id FROM lessons
     WHERE student_id = $1 AND status = 'completed' AND paid_cash = false
     ORDER BY date ASC, time ASC`,
    [studentId]
  );

  await client.query(
    'UPDATE lessons SET via_prepay = false, covered_by = NULL WHERE student_id = $1',
    [studentId]
  );

  let i = 0;
  for (const p of payments) {
    for (let k = 0; k < p.lessons_count && i < coverable.length; k++, i++) {
      await client.query(
        'UPDATE lessons SET via_prepay = true, covered_by = $1 WHERE id = $2',
        [p.id, coverable[i].id]
      );
    }
    if (i >= coverable.length) break;
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
function mapLesson(r, payMap) {
  // A covered lesson is worth its share of the payment that covered it, so a
  // discounted block prices its own lessons and nothing needs correcting.
  let effective = Number(r.amount);
  if (r.covered_by && payMap && payMap[r.covered_by]) {
    const p = payMap[r.covered_by];
    if (p.lessons_count > 0) effective = Number(p.amount) / p.lessons_count;
  }
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
    curriculumId: r.curriculum_id || null,
    coveredBy: r.covered_by || null,
    effectiveAmount: Math.round(effective * 100) / 100,
  };
}
function mapPayment(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    date: r.date,
    lessonsCount: r.lessons_count,
    amount: Number(r.amount),
    kind: r.kind || 'prepaid',
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
  const curRes = await q.query('SELECT * FROM curriculum WHERE active = true ORDER BY weekday, time');
  const creditsRes = await q.query('SELECT student_id, COALESCE(SUM(lessons_count),0) AS c FROM payments GROUP BY student_id');
  const usedRes = await q.query('SELECT student_id, COUNT(*) AS c FROM lessons WHERE via_prepay = true GROUP BY student_id');
  const payMap = {};
  paymentsRes.rows.forEach(r => { payMap[r.id] = r; });

  const creditsById = {};
  creditsRes.rows.forEach(r => { creditsById[r.student_id] = Number(r.c); });
  const usedById = {};
  usedRes.rows.forEach(r => { usedById[r.student_id] = Number(r.c); });

  return {
    students: studentsRes.rows.map(r => mapStudent(r, creditsById, usedById)),
    lessons: lessonsRes.rows.map(r => mapLesson(r, payMap)),
    payments: paymentsRes.rows.map(mapPayment),
    curriculum: curRes.rows.map(r => ({
      id: r.id, studentId: r.student_id, weekday: r.weekday, time: r.time,
      duration: r.duration, subject: r.subject, amount: Number(r.amount), startDate: r.start_date,
    })),
  };
}

// Runs a mutation in a transaction, reconciles, returns full state.
// fn returns the student id to reconcile, or null to reconcile everyone.
async function mutate(res, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentId = await fn(client);
    await syncCurriculum(client);
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
  // Reading also tops the rolling window up, so the curriculum never runs dry.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncCurriculum(client);
    const state = await fullState(client);
    await client.query('COMMIT');
    res.json(state);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Failed to load data' });
  } finally {
    client.release();
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
    const { lessonsCount, amount, date, notes, kind } = req.body;
    const count = Number(lessonsCount);
    if (!count || count <= 0) throw new Error('Lesson count must be at least 1');
    await client.query(
      `INSERT INTO payments (id, student_id, date, lessons_count, amount, notes, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), req.params.id, date || isoOf(new Date()), count, amount || 0, notes || '',
       kind === 'single' ? 'single' : 'prepaid']
    );
    return req.params.id;
  });
});

app.put('/api/payments/:id', (req, res) => {
  mutate(res, async (client) => {
    const { lessonsCount, amount, date, notes, kind } = req.body;
    const count = Number(lessonsCount);
    if (!count || count <= 0) throw new Error('Lesson count must be at least 1');
    const { rows } = await client.query(
      `UPDATE payments SET lessons_count=$1, amount=$2, date=$3, notes=$4, kind=$5
       WHERE id=$6 RETURNING student_id`,
      [count, amount || 0, date, notes || '', kind === 'single' ? 'single' : 'prepaid', req.params.id]
    );
    if (!rows[0]) throw new Error('Payment not found');
    return rows[0].student_id;
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
    // Fall back to the student's standard rate; a covering payment overrides
    // this later anyway.
    let price = amount;
    if (price == null || price === '') {
      const st = await client.query('SELECT rate FROM students WHERE id=$1', [studentId]);
      price = st.rows[0] ? Number(st.rows[0].rate) * ((Number(duration) || 60) / 60) : 0;
    }
    for (const d of list) {
      await client.query(
        `INSERT INTO lessons (id, student_id, date, time, duration, subject, amount, status, paid_cash, via_prepay, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`,
        [crypto.randomUUID(), studentId, d, time, duration, subject, price, status, !!paidCash, notes || '']
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

// Marks every outstanding lesson for one student as paid directly.
// Prepay-covered lessons are left alone — they're already settled.
app.post('/api/students/:id/settle', (req, res) => {
  mutate(res, async (client) => {
    await client.query(
      `UPDATE lessons SET paid_cash = true
       WHERE student_id = $1 AND status = 'completed'
         AND paid_cash = false AND via_prepay = false`,
      [req.params.id]
    );
    return req.params.id;
  });
});

// Marks an arbitrary set of lessons paid (or unpaid) in one go.
app.post('/api/lessons/bulk-paid', (req, res) => {
  mutate(res, async (client) => {
    const { ids, paid } = req.body;
    if (!Array.isArray(ids) || !ids.length) throw new Error('No lessons selected');
    await client.query(
      'UPDATE lessons SET paid_cash = $1 WHERE id = ANY($2::text[])',
      [!!paid, ids]
    );
    return null;
  });
});

// Deleting a lesson that came from the curriculum removes only that week.
// The slot keeps generating; only deleting it in Curriculum stops it.
app.delete('/api/lessons/:id', (req, res) => {
  mutate(res, async (client) => {
    const { rows } = await client.query(
      'DELETE FROM lessons WHERE id=$1 RETURNING student_id, curriculum_id, date',
      [req.params.id]
    );
    if (!rows[0]) return null;
    if (rows[0].curriculum_id) {
      await client.query(
        'INSERT INTO curriculum_skips (curriculum_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [rows[0].curriculum_id, rows[0].date]
      );
    }
    return rows[0].student_id;
  });
});

// ---------- Curriculum ----------
app.post('/api/curriculum', (req, res) => {
  mutate(res, async (client) => {
    const { studentId, weekday, time, duration, subject, amount, startDate } = req.body;
    if (!studentId || weekday == null || !time) throw new Error('Missing fields');
    await client.query(
      `INSERT INTO curriculum (id, student_id, weekday, time, duration, subject, amount, start_date, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [crypto.randomUUID(), studentId, Number(weekday), time, duration, subject, amount,
       startDate || isoOf(new Date())]
    );
    return studentId;
  });
});

app.put('/api/curriculum/:id', (req, res) => {
  mutate(res, async (client) => {
    const { studentId, weekday, time, duration, subject, amount } = req.body;
    const prev = await client.query('SELECT * FROM curriculum WHERE id=$1', [req.params.id]);
    if (!prev.rows[0]) throw new Error('Not found');
    await client.query(
      `UPDATE curriculum SET student_id=$1, weekday=$2, time=$3, duration=$4, subject=$5, amount=$6 WHERE id=$7`,
      [studentId, Number(weekday), time, duration, subject, amount, req.params.id]
    );
    // Future generated lessons are rebuilt from the new definition; anything
    // already completed or paid is left exactly as it is.
    const today = isoOf(new Date());
    await client.query(
      `DELETE FROM lessons
       WHERE curriculum_id=$1 AND date >= $2 AND status='scheduled' AND paid_cash=false AND via_prepay=false`,
      [req.params.id, today]
    );
    await client.query('DELETE FROM curriculum_skips WHERE curriculum_id=$1 AND date >= $2', [req.params.id, today]);
    return studentId;
  });
});

// Removing a slot from the curriculum is what actually stops the recurrence.
app.delete('/api/curriculum/:id', (req, res) => {
  mutate(res, async (client) => {
    const prev = await client.query('SELECT student_id FROM curriculum WHERE id=$1', [req.params.id]);
    const today = isoOf(new Date());
    await client.query(
      `DELETE FROM lessons
       WHERE curriculum_id=$1 AND date >= $2 AND status='scheduled' AND paid_cash=false AND via_prepay=false`,
      [req.params.id, today]
    );
    // Past lessons stay, but lose their link so nothing dangles.
    await client.query('UPDATE lessons SET curriculum_id=NULL WHERE curriculum_id=$1', [req.params.id]);
    await client.query('DELETE FROM curriculum WHERE id=$1', [req.params.id]);
    return prev.rows[0] ? prev.rows[0].student_id : null;
  });
});

// Bulk: mark every past scheduled lesson as completed.// Bulk: mark every past scheduled lesson as completed.
app.post('/api/lessons/complete-past', (req, res) => {
  mutate(res, async (client) => {
    const today = new Date().toISOString().slice(0, 10);
    await client.query(`UPDATE lessons SET status='completed' WHERE status='scheduled' AND date < $1`, [today]);
    return null;
  });
});

app.post('/api/reset', (req, res) => {
  mutate(res, async (client) => {
    await client.query('TRUNCATE TABLE lessons, payments, curriculum_skips, curriculum, students CASCADE');
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
