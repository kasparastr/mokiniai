# Tutoring Tracker

Standalone version of the tutoring lesson tracker: Overview, Calendar, Lessons, and
Students, backed by a real Postgres database instead of browser storage. Plain
Node/Express + vanilla JS — no build step.

## 1. Create the database (Neon)

1. Go to https://neon.tech, sign up, create a new project.
2. On the project dashboard, copy the **connection string** (it looks like
   `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`).
   Keep this handy — it's your `DATABASE_URL`.
3. You don't need to run any SQL yourself — the app creates its two tables
   (`students`, `lessons`) automatically the first time it starts.

## 2. Push this code to GitHub

```bash
cd tutoring-tracker-app
git init
git add .
git commit -m "Tutoring tracker"
```

Create a new **empty** repo on GitHub, then:

```bash
git remote add origin https://github.com/<you>/tutoring-tracker.git
git branch -M main
git push -u origin main
```

## 3. Deploy on Render

1. Go to https://render.com, sign up, connect your GitHub account.
2. **New +** → **Web Service** → pick your `tutoring-tracker` repo.
   (If Render finds `render.yaml`, it can also do this via **New +** → **Blueprint** instead.)
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment**, add:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `APP_PASSWORD` — any password you choose (strongly recommended — without
     it, anyone with your URL can see and edit your data)
5. **Create Web Service**. First deploy takes a couple of minutes.
6. Open the `.onrender.com` URL Render gives you. Your browser will prompt
   for a username (leave blank) and the `APP_PASSWORD` you set.

That's it — it's a real, independent website at that point. Add it to your
phone's home screen for an app-like icon.

## Notes

- **Free tier sleeps.** Render's free web services spin down after
  inactivity; the first request after a while can take ~30 seconds to wake
  up. Fine for personal use, worth knowing.
- **Custom domain:** Render lets you attach your own domain later for free,
  under the service's Settings → Custom Domain.
- **Local development:**
  ```bash
  cp .env.example .env   # fill in DATABASE_URL
  npm install
  npm run dev             # http://localhost:3000
  ```
- **Data model:** two tables, `students` and `lessons` (see `server.js` for
  the schema). Rate is per-hour per student; a lesson's amount auto-fills
  from rate × duration and can be edited per lesson.
