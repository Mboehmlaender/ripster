# Entwicklungsumgebung

---

## Voraussetzungen

- Node.js >= 20.19.0
- Alle [externen Tools](../getting-started/prerequisites.md) installiert

---

## Schnellstart

```bash
./start.sh
```

Das Skript startet automatisch:
- **Backend** auf Port 3001 (mit Nodemon für Hot-Reload)
- **Frontend** auf Port 5173 (mit Vite HMR)

---

## Manuelle Entwicklungsumgebung

### Terminal 1 – Backend

```bash
cd backend
npm install
npm run dev
```

Backend läuft auf `http://localhost:3001` mit **Nodemon** – Neustart bei Dateiänderungen.

### Terminal 2 – Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend läuft auf `http://localhost:5173` mit **Vite HMR** – sofortige Browser-Updates.

---

## Vite-Proxy

Im Entwicklungsmodus proxied Vite alle API- und WebSocket-Anfragen zum Backend:

```js
// frontend/vite.config.js
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:3001',
      changeOrigin: true
    },
    '/ws': {
      target: 'ws://localhost:3001',
      ws: true
    }
  }
}
```

Das bedeutet: Im Browser macht das Frontend Anfragen an `localhost:5173/api/...` – Vite leitet diese an `localhost:3001/api/...` weiter.

---

## Remote-Entwicklung

Falls Ripster auf einem entfernten Server entwickelt wird (z.B. Homeserver), muss die Vite-Konfiguration angepasst werden:

```env
# frontend/.env.local
VITE_API_BASE=http://192.168.1.100:3001
VITE_WS_URL=ws://192.168.1.100:3001
VITE_HMR_HOST=192.168.1.100
VITE_HMR_PORT=5173
```

---

## Log-Level für Entwicklung

```env
# backend/.env
LOG_LEVEL=debug
```

Im Debug-Modus werden alle Ausgaben der externen Tools (MakeMKV, HandBrake) vollständig geloggt.

---

## Stoppen

```bash
./kill.sh
```

---

## Linting & Type-Checking

```bash
# Frontend (ESLint)
cd frontend && npm run lint

# Backend hat keine separaten Lint-Scripts,
# nutze direkt eslint falls konfiguriert
```

---

## Deployment-Script

Das `deploy-ripster.sh`-Script überträgt Code auf einen Remote-Server per SSH:

```bash
./deploy-ripster.sh
```

**Was das Script tut:**
1. `rsync` synchronisiert den Code (Backend-Quellcode ohne `data/`)
2. Die Datenbank (`backend/data/`) wird **nicht** überschrieben
3. Verbindung via SSH (konfigurierbar im Script)

**Anpassung des Scripts:**

```bash
# deploy-ripster.sh
REMOTE_HOST="192.168.1.100"
REMOTE_USER="michael"
REMOTE_PATH="/home/michael/ripster"
```
