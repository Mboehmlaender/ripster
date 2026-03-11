# Produktions-Deployment

---

## Automatische Installation (empfohlen)

Das mitgelieferte `install.sh` richtet Ripster vollautomatisch ein – inklusive Node.js, MakeMKV, HandBrake, nginx und systemd-Dienst.

**Unterstützte Systeme laut Script:** Debian, Ubuntu, Linux Mint, Pop!_OS
**Voraussetzung:** root-Rechte, Internetzugang

### Schnellstart via curl

```bash
curl -fsSL https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh | sudo bash
```

Oder mit wget:

```bash
wget -qO- https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh | sudo bash
```

!!! warning "Optionen nur via Datei"
    Beim Pipen von curl/wget können keine Argumente übergeben werden. Für benutzerdefinierte Optionen zuerst herunterladen und dann mit `sudo bash install.sh [Optionen]` ausführen.

### Optionen

| Option | Standard | Beschreibung |
|--------|----------|--------------|
| `--branch <branch>` | `dev` | Git-Branch für die Installation |
| `--dir <pfad>` | `/opt/ripster` | Installationsverzeichnis |
| `--user <benutzer>` | `ripster` | Systembenutzer für den Dienst |
| `--port <port>` | `3001` | Backend-Port |
| `--host <hostname>` | Auto (Maschinen-IP) | Hostname/IP für die Weboberfläche |
| `--no-makemkv` | – | MakeMKV-Installation überspringen |
| `--no-handbrake` | – | HandBrake-Installation überspringen |
| `--no-nginx` | – | nginx-Einrichtung überspringen |
| `--reinstall` | – | Bestehende Installation aktualisieren (Daten bleiben erhalten) |
| `-h`, `--help` | – | Hilfe anzeigen |

### Beispiele

```bash
# Standard-Installation
sudo bash install.sh

# Anderen Branch und Port verwenden
sudo bash install.sh --branch dev --port 8080

# Ohne MakeMKV (bereits installiert)
sudo bash install.sh --no-makemkv

# Bestehende Installation aktualisieren
sudo bash install.sh --reinstall

# Ohne nginx (eigener Reverse-Proxy)
sudo bash install.sh --no-nginx --host mein-server.local
```

### Was das Skript erledigt

1. **Systemprüfung** – OS-Erkennung und Root-Check
2. **Systempakete** – `curl`, `wget`, `git`, `mediainfo`, `udev` u. a.
3. **Node.js 20** – via NodeSource, falls noch nicht installiert
4. **MakeMKV** – aktuelle Version wird aus dem offiziellen Forum ermittelt und aus dem Quellcode kompiliert (kann mit `--no-makemkv` übersprungen werden)
5. **HandBrake** – interaktive Auswahl:
    - **Option 1**: Standard (`apt install handbrake-cli`)
    - **Option 2**: Gebündelte GPU-Version mit NVDEC aus `bin/HandBrakeCLI`
6. **Systembenutzer** `ripster` – ohne Login-Shell und ohne Home-Verzeichnis; Gruppen werden (falls vorhanden) ergänzt: `cdrom`, `optical`, `disk`, `video`, `render`
7. **Repository** – klont Branch nach `--dir` (bei `--reinstall`: sichert `backend/data`, aktualisiert Repo, stellt Daten wieder her)
8. **Verzeichnisse** – stellt u. a. sicher: `backend/data`, `backend/logs`, `backend/data/output/raw`, `backend/data/output/movies`, `backend/data/logs`
9. **npm-Abhängigkeiten** – Root, Backend (nur production), Frontend
10. **Frontend-Build** – `npm run build` mit relativen API-URLs (nginx-kompatibel)
11. **Backend `.env`** – wird automatisch generiert (bei `--reinstall` bleibt bestehende `.env` erhalten)
12. **Berechtigungen** – zunächst `ripster:ripster` auf Installationsverzeichnis; bei sudo-Aufruf werden Output-/Log-Ordner auf `<aufrufender user>:ripster` mit `775` gesetzt; `.env` wird auf `600` gesetzt
13. **MakeMKV User-Ordner** – erstellt bei sudo-Aufruf `~/.MakeMKV` für den aufrufenden Benutzer
14. **systemd-Dienst** – `ripster-backend.service` erstellt, aktiviert und gestartet
15. **nginx** – konfiguriert als Reverse-Proxy für Frontend, `/api/` und `/ws` (kann mit `--no-nginx` übersprungen werden)

### Nach der Installation

```bash
# Status prüfen
sudo systemctl status ripster-backend

# Logs verfolgen
sudo journalctl -u ripster-backend -f

# Neustart
sudo systemctl restart ripster-backend

# Aktualisieren
sudo bash /opt/ripster/install.sh --reinstall
```

**Zugriff:** `http://<Maschinen-IP>` (oder der mit `--host` angegebene Hostname)

### HandBrake-Modus (GPU/NVDEC)

Bei nicht-interaktiver Ausführung (Pipe von curl) wird automatisch die Standard-Version gewählt. Für die GPU-Version zuerst herunterladen:

```bash
curl -fsSL https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh -o install.sh
sudo bash install.sh
# → Interaktive Auswahl: Option 2 für NVDEC
```

Das gebündelte Binary liegt unter `bin/HandBrakeCLI` und wird nach `/usr/local/bin/HandBrakeCLI` kopiert.

---

## Manuelle Installation

Die folgenden Abschnitte beschreiben die einzelnen Schritte für manuelle oder angepasste Setups.

### Empfohlene Architektur

```text
Client
  -> nginx (Reverse Proxy + statisches Frontend)
    -> Backend API/WebSocket (Node.js, Port 3001)
```

Wichtig: Das Backend serviert im aktuellen Stand keine `frontend/dist`-Dateien automatisch.

---

## 1) Frontend builden

```bash
cd frontend
npm install
npm run build
```

Artefakte liegen in `frontend/dist/`.

---

## 2) Backend als systemd-Service

Beispiel `/etc/systemd/system/ripster-backend.service`:

```ini
[Unit]
Description=Ripster Backend
After=network.target

[Service]
Type=simple
User=ripster
WorkingDirectory=/opt/ripster/backend
ExecStart=/usr/bin/env node src/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

Aktivieren:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ripster-backend
sudo systemctl status ripster-backend
```

---

## 3) nginx konfigurieren

Beispiel `/etc/nginx/sites-available/ripster`:

```nginx
server {
    listen 80;
    server_name ripster.local;

    root /opt/ripster/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Aktivieren:

```bash
sudo ln -s /etc/nginx/sites-available/ripster /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Datenbank-Backup

```bash
sqlite3 /opt/ripster/backend/data/ripster.db \
  ".backup '/var/backups/ripster-$(date +%Y%m%d).db'"
```

---

## Sicherheit

- Ripster hat keine eingebaute Authentifizierung.
- Für externen Zugriff mindestens Basic Auth + TLS + Netzwerksegmentierung/VPN einsetzen.
- Secrets nicht ins Repo committen (`.env`, Settings-Felder).
