# tvmountok-api
Backend for tvmountok.com: lead intake (`POST /api/lead`), SQLite database, admin panel at admin.tvmountok.com, Signal alerts. Zero npm dependencies (Node 24 `node:sqlite`).

Env: `ADMIN_PASSWORD` (12+ chars), `SESSION_SECRET` (32+ chars), `ALLOWED_ORIGINS`, `SIGNAL_URL`, `SIGNAL_NUMBER`, `SIGNAL_RECIPIENTS`, `PANEL_URL`, `DATA_DIR` (/data volume).
Run: `docker run -d --name tvmountok-api -p 8083:8083 -v /path/data:/data --env-file .env ghcr.io/hfellc/tvmountok-api:latest`
