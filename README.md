# Showtime Forecast — Cinema Audience Console

A small full-stack app: an Express backend with real accounts (bcrypt-hashed
passwords, JWT session cookies) and a ticket-booth themed frontend that talks
to it over a real HTTP API — no browser-storage tricks, no artifact sandbox
dependency.

## Run it

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

## What's real vs. simulated

- **Real:** accounts, login sessions (cookie-based, 30 days), password
  hashing (bcrypt), the forecast math itself (runs server-side in
  `server.js`), and your saved forecast history (persisted to `db.json`).
- **Simulated:** the theaters and their historical baselines are realistic
  sample data, not the actual Cinema Audience Forecasting competition
  dataset — no dataset or trained model was provided. The "Model Bake-Off"
  R² scores are illustrative, standing in for the five regressors
  (Ridge, Lasso, GradientBoosting, XGBoost, LightGBM) trained in the
  original notebook.

## Wiring in the real notebook pipeline

To turn this into a genuine prediction service:

1. Train and save the notebook's final LightGBM model (e.g. with
   `joblib.dump` or `model.booster_.save_model(...)`).
2. Stand up a small Python inference service (FastAPI/Flask) that loads
   the model and the same feature-engineering steps from the notebook.
3. Replace `computeForecast()` in `server.js` with a call to that service
   instead of the sample day-of-week/seasonal formula.
4. Replace the `theaters` array with theaters pulled from
   `booknow_theaters.csv` and their real historical stats.

## Pages

- `/login` — sign in / sign up (public)
- `/` — Forecast console: pick a theater, print a ticket (protected)
- `/theaters` — browse sample + community theaters and their weekly patterns (protected)
- `/add-theater` — register your own theater (name, area, type, baseline, custom weekly pattern) and manage ones you've added (protected)
- `/history` — your full saved forecast log (protected)
- `/about` — how the forecast logic and model bake-off work (protected)

Visiting any protected page while logged out redirects to `/login`
server-side; visiting `/login` while already logged in redirects to `/`.

## Project structure

```
cinema-forecast-app/
├── server.js              # Express API + page routing/auth redirects
├── package.json
├── public/
│   ├── login.html         # Public login/signup page
│   ├── assets/
│   │   ├── styles.css     # Shared styles for every page
│   │   └── api.js         # Shared fetch helper + nav/logout wiring
│   └── pages/
│       ├── index.html       # Forecast console (served at /)
│       ├── theaters.html    # Theater reference page (served at /theaters)
│       ├── add-theater.html # Register a theater (served at /add-theater)
│       ├── history.html     # Full forecast log (served at /history)
│       └── about.html       # Methodology (served at /about)
└── db.json                 # Created automatically on first run
```

## Notes

- `db.json` is a flat JSON file used as a lightweight local database —
  fine for a demo, swap for Postgres/SQLite/etc. before deploying for real.
- Set `JWT_SECRET` as an environment variable before deploying anywhere
  public; the default is a placeholder dev secret.
