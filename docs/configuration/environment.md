# Umgebungsvariablen

Umgebungsvariablen überschreiben die Standardwerte und eignen sich für Server-Deployments.

---

## Backend-Umgebungsvariablen

Konfigurationsdatei: `backend/.env`

| Variable | Standard | Beschreibung |
|---------|---------|-------------|
| `PORT` | `3001` | Port des Express-Servers |
| `DB_PATH` | `./data/ripster.db` | Pfad zur SQLite-Datenbankdatei |
| `CORS_ORIGIN` | `http://localhost:5173` | Erlaubter CORS-Origin |
| `LOG_DIR` | `./logs` | Verzeichnis für Log-Dateien |
| `LOG_LEVEL` | `info` | Log-Level (`debug`, `info`, `warn`, `error`) |

### Beispiel: backend/.env

```env
PORT=3001
DB_PATH=/var/lib/ripster/ripster.db
CORS_ORIGIN=http://192.168.1.100:5173
LOG_DIR=/var/log/ripster
LOG_LEVEL=info
```

---

## Frontend-Umgebungsvariablen

Konfigurationsdatei: `frontend/.env`

| Variable | Standard | Beschreibung |
|---------|---------|-------------|
| `VITE_API_BASE` | `http://localhost:3001` | Backend-API-URL |
| `VITE_WS_URL` | `ws://localhost:3001` | WebSocket-URL |
| `VITE_PUBLIC_ORIGIN` | — | Öffentliche Origin-URL (für CORS) |
| `VITE_HMR_HOST` | — | Vite HMR-Host (für Remote-Entwicklung) |
| `VITE_HMR_PORT` | — | Vite HMR-Port |

### Beispiel: frontend/.env (Entwicklung)

```env
VITE_API_BASE=http://localhost:3001
VITE_WS_URL=ws://localhost:3001
```

### Beispiel: frontend/.env (Netzwerk-Zugriff)

```env
VITE_API_BASE=http://192.168.1.100:3001
VITE_WS_URL=ws://192.168.1.100:3001
VITE_PUBLIC_ORIGIN=http://192.168.1.100:5173
```

---

## .env.example Dateien

Das Repository enthält Vorlagen für beide Konfigurationsdateien:

```bash
# Backend
cp backend/.env.example backend/.env

# Frontend
cp frontend/.env.example frontend/.env
```

---

## Priorität der Konfiguration

Einstellungen werden in folgender Reihenfolge geladen (höhere Priorität überschreibt niedrigere):

```
1. Systemumgebungsvariablen (export VAR=value)
2. .env-Datei
3. Hardcodierte Standardwerte in config.js
```

---

## LOG_LEVEL

| Level | Ausgabe |
|-------|---------|
| `debug` | Alle Meldungen inkl. Debugging |
| `info` | Normale Betriebsinformationen |
| `warn` | Warnungen + Fehler |
| `error` | Nur Fehler |

!!! tip "Produktionsempfehlung"
    Für Produktionsumgebungen `LOG_LEVEL=info` oder `LOG_LEVEL=warn` verwenden. `debug` erzeugt sehr viele Log-Einträge.
