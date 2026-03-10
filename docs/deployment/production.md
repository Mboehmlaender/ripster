# Produktions-Deployment

---

## Empfohlene Architektur

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
