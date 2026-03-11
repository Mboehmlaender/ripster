# Installation

Die empfohlene Installation läuft über `install.sh` und richtet Ripster vollständig ein.

## Zielbild nach der Installation

- Ripster-Backend als `systemd`-Dienst
- Frontend über nginx erreichbar
- UI auf `http://<Server-IP>`

## Schritt-für-Schritt

### 1. Installationsskript herunterladen

```bash
wget -qO install.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh
```

### 2. Installation ausführen

```bash
sudo bash install.sh
```

Während der Installation wirst du nach dem HandBrake-Modus gefragt:

- `1` Standard (`apt`)
- `2` GPU/NVDEC (gebündeltes Binary)

### 3. Dienststatus prüfen

```bash
sudo systemctl status ripster-backend
```

### 4. Weboberfläche öffnen

- Mit nginx: `http://<Server-IP>`
- Ohne nginx (`--no-nginx`): API auf `http://<Server-IP>:3001/api`

## Wichtige Optionen

| Option | Zweck |
|---|---|
| `--branch <branch>` | anderen Branch installieren |
| `--dir <pfad>` | Installationsverzeichnis ändern |
| `--port <port>` | Backend-Port setzen |
| `--host <hostname>` | Hostname/IP für nginx/CORS |
| `--no-makemkv` | MakeMKV nicht installieren |
| `--no-handbrake` | HandBrake nicht installieren |
| `--no-nginx` | nginx-Konfiguration überspringen |
| `--reinstall` | Update einer bestehenden Installation |

Beispiele:

```bash
sudo bash install.sh --branch dev
sudo bash install.sh --port 8080 --host ripster.local
sudo bash install.sh --reinstall
```

## Betrieb im Alltag

```bash
# Logs live ansehen
sudo journalctl -u ripster-backend -f

# Dienst neu starten
sudo systemctl restart ripster-backend

# Update aus bestehender Installation
sudo bash /opt/ripster/install.sh --reinstall
```

## Häufige Stolperstellen

- `Permission denied` am Laufwerk: Laufwerksrechte/Gruppen prüfen
- Tools nicht gefunden: `makemkvcon`, `HandBrakeCLI`, `mediainfo` im `PATH` prüfen
- UI nicht erreichbar: nginx-Status und Port/Firewall prüfen

## Danach weiter

1. [Ersteinrichtung](configuration.md)
2. [Erster Lauf](quickstart.md)
