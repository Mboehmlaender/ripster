# Umgebungsvariablen

Umgebungsvariablen steuern Backend/Vite außerhalb der DB-basierten UI-Settings.

---

## Backend (`backend/.env`)

| Variable | Default (Code) | Beschreibung |
|---------|------------------|-------------|
| `PORT` | `3001` | Express-Port |
| `DB_PATH` | `backend/data/ripster.db` | SQLite-Datei (relativ zu `backend/`) |
| `LOG_DIR` | `backend/logs` | Fallback-Logverzeichnis (wenn `log_dir`-Setting nicht gesetzt/lesbar) |
| `CORS_ORIGIN` | `*` | CORS-Origin für API |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Beispiel:

```env
PORT=3001
DB_PATH=/var/lib/ripster/ripster.db
LOG_DIR=/var/log/ripster
CORS_ORIGIN=http://192.168.1.50:5173
LOG_LEVEL=info
```

Hinweis: `backend/.env.example` enthält bewusst dev-freundliche Werte (z. B. lokaler `CORS_ORIGIN`).

---

## Frontend (`frontend/.env`)

| Variable | Default | Beschreibung |
|---------|---------|-------------|
| `VITE_API_BASE` | `/api` | API-Basis für Fetch-Client |
| `VITE_WS_URL` | automatisch aus `window.location` + `/ws` | Optional explizite WebSocket-URL |
| `VITE_PUBLIC_ORIGIN` | leer | Öffentliche Vite-Origin (Remote-Dev) |
| `VITE_ALLOWED_HOSTS` | `true` | Komma-separierte Hostliste für Vite `allowedHosts` |
| `VITE_HMR_PROTOCOL` | abgeleitet aus `VITE_PUBLIC_ORIGIN` | HMR-Protokoll (`ws`/`wss`) |
| `VITE_HMR_HOST` | abgeleitet aus `VITE_PUBLIC_ORIGIN` | HMR-Host |
| `VITE_HMR_CLIENT_PORT` | abgeleitet aus `VITE_PUBLIC_ORIGIN` | HMR-Client-Port |

Beispiele:

```env
# lokal (mit Vite-Proxy)
VITE_API_BASE=/api
```

```env
# remote dev
VITE_API_BASE=http://192.168.1.50:3001/api
VITE_WS_URL=ws://192.168.1.50:3001/ws
VITE_PUBLIC_ORIGIN=http://192.168.1.50:5173
VITE_ALLOWED_HOSTS=192.168.1.50,ripster.local
VITE_HMR_PROTOCOL=ws
VITE_HMR_HOST=192.168.1.50
VITE_HMR_CLIENT_PORT=5173
```

---

## Priorität

1. Prozess-Umgebungsvariablen
2. `.env`
3. Code-Defaults
