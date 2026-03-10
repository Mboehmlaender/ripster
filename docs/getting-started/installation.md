# Installation

---

## Repository klonen

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/ripster.git
cd ripster
```

---

## Dev-Start (empfohlen)

```bash
./start.sh
```

`start.sh`:

1. prüft Node-Version (`>= 20.19.0`)
2. installiert Dependencies (Root/Backend/Frontend)
3. startet Backend + Frontend parallel

Danach:

- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173`

Stoppen: mit `Ctrl+C` im laufenden Terminal.

---

## Manuell starten

```bash
npm install
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Oder getrennt:

```bash
npm run dev:backend
npm run dev:frontend
```

---

## Optional: .env-Dateien anlegen

### Backend

```bash
cp backend/.env.example backend/.env
```

Beispiel:

```env
PORT=3001
DB_PATH=./data/ripster.db
LOG_DIR=./logs
CORS_ORIGIN=http://localhost:5173
LOG_LEVEL=info
```

### Frontend

```bash
cp frontend/.env.example frontend/.env
```

Beispiel:

```env
VITE_API_BASE=/api
# optional:
# VITE_WS_URL=ws://localhost:3001/ws
```

---

## Datenbank

SQLite wird automatisch beim Backend-Start initialisiert:

```text
backend/data/ripster.db
```

Schema-Quelle: `db/schema.sql`

---

## Nächste Schritte

1. Browser öffnen: `http://localhost:5173`
2. In `Settings` Pfade/Tools/API-Keys prüfen
3. Erste Disc einlegen und Workflow starten
