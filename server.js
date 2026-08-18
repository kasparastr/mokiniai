const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

// ---------- Optional password gate ----------
// Set APP_PASSWORD as an environment variable to require it. If unset, the
// app is open to anyone with the URL — fine for local testing, not
// recommended once deployed.
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
      paid BOOLEAN NOT NULL DEFAULT false,
      notes TEXT DEFAULT ''
    );
  `);
}

function rowToStudent(r) {
  return { id: r.id, name: r.name, subject: r.subject, rate: Number(r.rate), color: r.color };
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
    const { name, subject, rate, color } = req.body;
    if (!name || !subject || rate == null || !color) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO students (id, name, subject, rate, color) VALUES ($1,$2,$3,$4,$5)',
      [id, name, subject, rate, color]
    );
    res.json({ id, name, subject, rate: Number(rate), color });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { name, subject, rate, color } = req.body;
    await pool.query(
      'UPDATE students SET name=$1, subject=$2, rate=$3, color=$4 WHERE id=$5',
      [name, subject, rate, color, req.params.id]
    );
    res.json({ id: req.params.id, name, subject, rate: Number(rate), color });
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
      `INSERT INTO lessons (id, student_id, date, time, duration, subject, amount, status, paid, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, studentId, date, time, duration, subject, amount, status, !!paid, notes || '']
    );
    res.json({ id, studentId, date, time, duration, subject, amount: Number(amount), status, paid: !!paid, notes: notes || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create lesson' });
  }
});

app.put('/api/lessons/:id', async (req, res) => {
  try {
    const { studentId, date, time, duration, subject, amount, status, paid, notes } = req.body;
    await pool.query(
      `UPDATE lessons SET student_id=$1, date=$2, time=$3, duration=$4, subject=$5, amount=$6, status=$7, paid=$8, notes=$9
       WHERE id=$10`,
      [studentId, date, time, duration, subject, amount, status, !!paid, notes || '', req.params.id]
    );
    res.json({ id: req.params.id, studentId, date, time, duration, subject, amount: Number(amount), status, paid: !!paid, notes: notes || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

app.patch('/api/lessons/:id/paid', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT paid FROM lessons WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const newPaid = !rows[0].paid;
    await pool.query('UPDATE lessons SET paid=$1 WHERE id=$2', [newPaid, req.params.id]);
    res.json({ id: req.params.id, paid: newPaid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to toggle paid' });
  }
});

app.delete('/api/lessons/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM lessons WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete lesson' });
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
