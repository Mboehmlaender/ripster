# Produktions-Deployment

---

## Empfohlene Architektur

```
Internet / Heimnetz
        ↓
   nginx (Reverse Proxy)
        ↓
   ┌────┴────┐
   │         │
Backend   Frontend
 :3001     (statische Dateien)
```

---

## systemd-Service

Für ein dauerhaftes Betreiben als systemd-Service:

```bash
sudo nano /etc/systemd/system/ripster.service
```

```ini
[Unit]
Description=Ripster - Disc Ripping Service
After=network.target

[Service]
Type=simple
User=michael
WorkingDirectory=/home/michael/ripster
ExecStart=/bin/bash /home/michael/ripster/start.sh
ExecStop=/bin/bash /home/michael/ripster/kill.sh
Restart=on-failure
RestartSec=10s

# Umgebungsvariablen
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

```bash
# Service aktivieren und starten
sudo systemctl daemon-reload
sudo systemctl enable ripster
sudo systemctl start ripster

# Status prüfen
sudo systemctl status ripster

# Logs anzeigen
journalctl -u ripster -f
```

---

## Frontend-Build

Für Produktion das Frontend bauen:

```bash
cd frontend
npm run build
```

Die statischen Dateien landen in `frontend/dist/`.

---

## nginx-Konfiguration

```nginx
# /etc/nginx/sites-available/ripster
server {
    listen 80;
    server_name ripster.local;

    # Statisches Frontend
    root /home/michael/ripster/frontend/dist;
    index index.html;

    # SPA Fallback (React Router)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API-Proxy zum Backend
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket-Proxy
    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ripster /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Nur-Backend-Produktion (ohne nginx)

Falls kein Reverse Proxy gewünscht ist, kann das Backend die Frontend-Dateien direkt ausliefern:

```bash
# Frontend bauen
cd frontend && npm run build

# Backend startet und serviert frontend/dist/
cd backend && NODE_ENV=production npm start
```

Das Backend ist so konfiguriert, dass es im Produktionsmodus die `frontend/dist/`-Dateien als statische Assets ausliefert.

---

## Datenbank-Backup

```bash
# Datenbank sichern
cp backend/data/ripster.db backend/data/ripster.db.backup.$(date +%Y%m%d)

# Oder mit SQLite-eigenem Backup-Befehl
sqlite3 backend/data/ripster.db ".backup '/mnt/backup/ripster.db'"
```

!!! tip "Automatisches Backup"
    Cron-Job für tägliches Backup:
    ```cron
    0 3 * * * sqlite3 /home/michael/ripster/backend/data/ripster.db ".backup '/mnt/backup/ripster-$(date +\%Y\%m\%d).db'"
    ```

---

## Log-Rotation

Ripster rotiert Logs automatisch täglich. Falls zusätzlich systemd-Journal-Rotation gewünscht ist:

```bash
# /etc/logrotate.d/ripster
/home/michael/ripster/backend/logs/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
```

---

## Sicherheitshinweise

!!! warning "Heimnetz-Einsatz"
    Ripster ist für den Einsatz im **lokalen Heimnetz** konzipiert und enthält **keine Authentifizierung**. Stelle sicher, dass der Dienst nicht öffentlich erreichbar ist.

Falls öffentlicher Zugang benötigt wird:

1. **Basic Auth** via nginx:
   ```bash
   sudo htpasswd -c /etc/nginx/.htpasswd michael
   ```
   ```nginx
   location / {
       auth_basic "Ripster";
       auth_basic_user_file /etc/nginx/.htpasswd;
       # ...
   }
   ```

2. **VPN-Zugang** (empfohlen): Zugriff nur über WireGuard/OpenVPN

3. **SSL/TLS**: Let's Encrypt mit certbot für HTTPS
