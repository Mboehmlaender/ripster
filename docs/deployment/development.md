# Entwicklungsumgebung

---

## Voraussetzungen

- Node.js >= 20.19.0
- externe Tools installiert (`makemkvcon`, `HandBrakeCLI`, `mediainfo`)

---

## Schnellstart

```bash
./start.sh
```

Startet:

- Backend (`http://localhost:3001`, mit nodemon)
- Frontend (`http://localhost:5173`, mit Vite HMR)

Stoppen: `Ctrl+C`.

---

## Manuell

### Backend

```bash
cd backend
npm install
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## Vite-Proxy (Dev)

`frontend/vite.config.js` proxied standardmäßig:

- `/api` -> `http://127.0.0.1:3001`
- `/ws` -> `ws://127.0.0.1:3001`

---

## Remote-Dev (optional)

Beispiel `frontend/.env.local`:

```env
VITE_API_BASE=http://192.168.1.100:3001/api
VITE_WS_URL=ws://192.168.1.100:3001/ws
VITE_PUBLIC_ORIGIN=http://192.168.1.100:5173
VITE_ALLOWED_HOSTS=192.168.1.100,ripster.local
VITE_HMR_PROTOCOL=ws
VITE_HMR_HOST=192.168.1.100
VITE_HMR_CLIENT_PORT=5173
```

---

## Nützliche Kommandos

```bash
# Root dev (backend + frontend)
npm run dev

# einzeln
npm run dev:backend
npm run dev:frontend

# Frontend Build
npm run build:frontend
```

