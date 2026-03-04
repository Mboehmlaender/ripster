# Installation

---

## Repository klonen

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/ripster.git
cd ripster
```

---

## Automatischer Start

Ripster enthält ein `start.sh`-Skript, das alle Abhängigkeiten installiert und Backend + Frontend gleichzeitig startet:

```bash
./start.sh
```

Das Skript führt automatisch folgende Schritte durch:

1. **Node.js-Versionscheck** – prüft ob >= 20.19.0 verfügbar ist (mit nvm/npx-Fallback)
2. **Abhängigkeiten installieren** – `npm install` für Root, Backend und Frontend
3. **Dienste starten** – Backend und Frontend werden parallel gestartet

!!! success "Erfolgreich gestartet"
    - Backend läuft auf `http://localhost:3001`
    - Frontend läuft auf `http://localhost:5173`

---

## Manuelle Installation

Falls du mehr Kontrolle benötigst:

```bash
# Root-Abhängigkeiten
npm install

# Backend-Abhängigkeiten
cd backend && npm install && cd ..

# Frontend-Abhängigkeiten
cd frontend && npm install && cd ..

# Backend starten (Terminal 1)
cd backend && npm run dev

# Frontend starten (Terminal 2)
cd frontend && npm run dev
```

---

## Umgebungsvariablen konfigurieren

### Backend

```bash
cp backend/.env.example backend/.env
```

Bearbeite `backend/.env`:

```env
PORT=3001
DB_PATH=./data/ripster.db
CORS_ORIGIN=http://localhost:5173
LOG_DIR=./logs
LOG_LEVEL=info
```

### Frontend

```bash
cp frontend/.env.example frontend/.env
```

Bearbeite `frontend/.env`:

```env
VITE_API_BASE=http://localhost:3001
VITE_WS_URL=ws://localhost:3001
```

!!! tip "Alle Umgebungsvariablen"
    Eine vollständige Übersicht aller Umgebungsvariablen findest du unter [Umgebungsvariablen](../configuration/environment.md).

---

## Datenbank initialisieren

Die SQLite-Datenbank wird **automatisch** beim ersten Start erstellt und mit dem Schema aus `db/schema.sql` initialisiert. Es sind keine manuellen Datenbankschritte erforderlich.

```
backend/data/
└── ripster.db    ← Wird automatisch angelegt
```

---

## Stoppen

```bash
./kill.sh
```

Das Skript beendet Backend- und Frontend-Prozesse graceful.

---

## Verzeichnisstruktur nach Installation

```
ripster/
├── backend/
│   ├── data/           ← SQLite-Datenbank (nach erstem Start)
│   ├── logs/           ← Log-Dateien
│   ├── node_modules/   ← Backend-Abhängigkeiten
│   └── .env            ← Backend-Konfiguration
├── frontend/
│   ├── node_modules/   ← Frontend-Abhängigkeiten
│   ├── dist/           ← Production-Build (nach npm run build)
│   └── .env            ← Frontend-Konfiguration
└── node_modules/       ← Root-Abhängigkeiten (concurrently etc.)
```

---

## Nächste Schritte

Nach erfolgreicher Installation:

1. Öffne [http://localhost:5173](http://localhost:5173)
2. Navigiere zu **Einstellungen**
3. Konfiguriere Pfade, API-Keys und Encoding-Presets

[:octicons-arrow-right-24: Zur Konfiguration](configuration.md)
