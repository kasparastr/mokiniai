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
  const providedPassword = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (providedPassword === password) return next();
  res.set('WWW-Authenticate', 'Basic realm="Tutoring Tracker"');
  return res.status(401).send('Authentication required');
}
app.use(basicAuth);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      rate NUMERIC NOT NULL,
      color TEXT NOT NULL,
      grade TEXT DEFAULT '',
      prepaid_balance INTEGER NOT NULL DEFAULT 0
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
      paid BOOLEAN NOT NULL DEFAULT false,
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
  // Migrations for databases created before these columns existed.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS grade TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS prepaid_balance INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS via_prepay BOOLEAN NOT NULL DEFAULT false`);
}

function rowToStudent(r) {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    rate: Number(r.rate),
    color: r.color,
    grade: r.grade || '',
    prepaidBalance: r.prepaid_balance,
  };
}
function rowToLesson(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    date: r.date,
    time: r.time,
    duration: r.duration,
    subject: r.subject,
    amount: Number(r.amount),
    status: r.status,
    paid: r.paid,
    viaPrepay: r.via_prepay,
    notes: r.notes || '',
  };
}
function rowToPayment(r) {
  return {
    id: r.id,
    studentId: r.student_id,
    date: r.date,
    lessonsCount: r.lessons_count,
    amount: Number(r.amount),
    notes: r.notes || '',
  };
}

// ---------- Students ----------
app.get('/api/students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM students ORDER BY name');
    res.json(rows.map(rowToStudent));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, subject, rate, color, grade } = req.body;
    if (!name || !subject || rate == null || !color) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO students (id, name, subject, rate, color, grade) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, subject, rate, color, grade || '']
    );
    res.json({ id, name, subject, rate: Number(rate), color, grade: grade || '', prepaidBalance: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { name, subject, rate, color, grade } = req.body;
    const { rows } = await pool.query(
      'UPDATE students SET name=$1, subject=$2, rate=$3, color=$4, grade=$5 WHERE id=$6 RETURNING *',
      [name, subject, rate, color, grade || '', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rowToStudent(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

// ---------- Prepayments (mothers paying for a block of lessons upfront) ----------
app.get('/api/payments', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payments ORDER BY date DESC');
    res.json(rows.map(rowToPayment));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

app.post('/api/students/:id/prepayments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { lessonsCount, amount, notes } = req.body;
    const count = Number(lessonsCount);
    if (!count || count <= 0 || amount == null) {
      client.release();
      return res.status(400).json({ error: 'Missing fields' });
    }
    await client.query('BEGIN');
    const id = crypto.randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    await client.query(
      'INSERT INTO payments (id, student_id, date, lessons_count, amount, notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.params.id, date, count, amount, notes || '']
    );
    const { rows } = await client.query(
      'UPDATE students SET prepaid_balance = prepaid_balance + $1 WHERE id=$2 RETURNING *',
      [count, req.params.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Student not found' });
    }
    await client.query('COMMIT');
    res.json({
      payment: { id, studentId: req.params.id, date, lessonsCount: count, amount: Number(amount), notes: notes || '' },
      student: rowToStudent(rows[0]),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to record prepayment' });
  } finally {
    client.release();
  }
});

// ---------- Lessons ----------
app.get('/api/lessons', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM lessons ORDER BY date, time');
    res.json(rows.map(rowToLesson));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load lessons' });
  }
});

app.post('/api/lessons', async (req, res) => {
  try {
    const { studentId, date, time, duration, subject, amount, status, paid, notes } = req.body;
    if (!studentId || !date || !time) return res.status(400).json({ error: 'Missing fields' });
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO lessons (id, student_id, date, time, duration, subject, amount, status, paid, via_prepay, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`,
      [id, studentId, date, time, duration, subject, amount, status, !!paid, notes || '']
    );
    res.json({ id, studentId, date, time, duration, subject, amount: Number(amount), status, paid: !!paid, viaPrepay: false, notes: notes || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create lesson' });
  }
});

app.put('/api/lessons/:id', async (req, res) => {
  try {
    const { studentId, date, time, duration, subject, amount, status, paid, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE lessons SET student_id=$1, date=$2, time=$3, duration=$4, subject=$5, amount=$6, status=$7, paid=$8, notes=$9
       WHERE id=$10 RETURNING *`,
      [studentId, date, time, duration, subject, amount, status, !!paid, notes || '', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rowToLesson(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// Direct paid/unpaid toggle. If this un-marks a lesson that was covered by a
// prepay credit, the credit is refunded back onto the student's balance.
app.patch('/api/lessons/:id/paid', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM lessons WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Not found' });
    }
    const lesson = rows[0];
    const newPaid = !lesson.paid;
    if (!newPaid && lesson.via_prepay) {
      await client.query('UPDATE lessons SET paid=false, via_prepay=false WHERE id=$1', [req.params.id]);
      await client.query('UPDATE students SET prepaid_balance = prepaid_balance + 1 WHERE id=$1', [lesson.student_id]);
    } else {
      await client.query('UPDATE lessons SET paid=$1, via_prepay=false WHERE id=$2', [newPaid, req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ id: req.params.id, paid: newPaid, viaPrepay: false });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to toggle paid' });
  } finally {
    client.release();
  }
});

// Mark a lesson paid by drawing down one credit from the student's prepaid balance.
app.patch('/api/lessons/:id/use-prepay', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM lessons WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Not found' });
    }
    const lesson = rows[0];
    if (lesson.paid) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Already paid' });
    }
    const studentRows = await client.query('SELECT prepaid_balance FROM students WHERE id=$1 FOR UPDATE', [lesson.student_id]);
    const balance = studentRows.rows[0] ? studentRows.rows[0].prepaid_balance : 0;
    if (balance <= 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'No prepaid balance available' });
    }
    await client.query('UPDATE lessons SET paid=true, via_prepay=true WHERE id=$1', [req.params.id]);
    await client.query('UPDATE students SET prepaid_balance = prepaid_balance - 1 WHERE id=$1', [lesson.student_id]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, paid: true, viaPrepay: true, newBalance: balance - 1 });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to use prepay credit' });
  } finally {
    client.release();
  }
});

app.delete('/api/lessons/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM lessons WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (rows[0] && rows[0].via_prepay && rows[0].paid) {
      await client.query('UPDATE students SET prepaid_balance = prepaid_balance + 1 WHERE id=$1', [rows[0].student_id]);
    }
    await client.query('DELETE FROM lessons WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to delete lesson' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Tutoring tracker running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
