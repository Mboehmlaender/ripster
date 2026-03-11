# Installation

Die empfohlene Installation läuft über `install.sh` und richtet Ripster vollständig ein.

Du musst dafür **keine Tools manuell vorinstallieren**. Das Skript installiert die benötigten Abhängigkeiten automatisch, sofern sie nicht explizit mit `--no-*` übersprungen werden.

## Unterstützte Systeme und Anforderungen

- unterstützt laut Script: `debian`, `ubuntu`, `linuxmint`, `pop`
- Ausführung als `root` (oder via `sudo`)
- Internetzugang während der Installation

## Schritt-für-Schritt

### 1. Installationsskript herunterladen

```bash
wget -qO install.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh
```

### 2. Installation ausführen

```bash
sudo bash install.sh
```

Während der Installation wählst du den HandBrake-Modus:

- `1` Standard (Paketinstallation)
- `2` GPU/NVDEC (gebündeltes Binary)

### 3. Dienststatus prüfen

```bash
sudo systemctl status ripster-backend
```

### 4. Weboberfläche öffnen

- mit nginx (Standard): `http://<Server-IP>`
- ohne nginx (`--no-nginx`): API auf `http://<Server-IP>:3001/api`

## Was `install.sh` konkret einrichtet

1. prüft Betriebssystem, Root-Rechte und ermittelt Host/IP
2. aktualisiert Paketquellen und installiert Basispakete (`curl`, `wget`, `git`, `mediainfo`, `udev` ...)
3. installiert Node.js 20 (falls nicht passend vorhanden)
4. installiert optional MakeMKV (Build aus den offiziellen Quellen)
5. installiert optional HandBrakeCLI (Standard oder GPU/NVDEC)
6. installiert optional nginx
7. legt den Systembenutzer `ripster` an (ohne Login-Shell, ohne Home) und ergänzt Gruppen (`cdrom`, `optical`, `disk`, `video`, `render`, falls vorhanden)
8. klont das Repository nach `/opt/ripster` (oder aktualisiert bei `--reinstall`)
9. legt Verzeichnisse an:
   - `/opt/ripster/backend/data`
   - `/opt/ripster/backend/logs`
   - `/opt/ripster/backend/data/output/raw`
   - `/opt/ripster/backend/data/output/movies`
   - `/opt/ripster/backend/data/logs`
10. installiert npm-Abhängigkeiten (Root, Backend, Frontend) und baut das Frontend
11. erzeugt `backend/.env` (bei `--reinstall` bleibt bestehende `.env` erhalten)
12. setzt Rechte/Besitz und erstellt bei sudo-Installation zusätzlich `~/.MakeMKV` für den aufrufenden Benutzer
13. erzeugt und startet `ripster-backend.service`
14. konfiguriert und startet nginx (falls nicht übersprungen)

## Wichtige Optionen

| Option | Default laut Script | Zweck |
|---|---|---|
| `--branch <branch>` | `dev` | Branch für die Installation |
| `--dir <pfad>` | `/opt/ripster` | Installationsverzeichnis |
| `--user <benutzer>` | `ripster` | Service-Benutzer |
| `--port <port>` | `3001` | Backend-Port |
| `--host <hostname>` | automatisch ermittelte Host-IP | Hostname/IP für Webzugriff/CORS |
| `--no-makemkv` | aus | MakeMKV-Installation überspringen |
| `--no-handbrake` | aus | HandBrake-Installation überspringen |
| `--no-nginx` | aus | nginx-Setup überspringen |
| `--reinstall` | aus | bestehende Installation aktualisieren |

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

- Laufwerk nicht zugreifbar: Laufwerksrechte/Gruppen prüfen
- CLI-Tool fehlt wegen `--no-*`: Tool nachinstallieren oder Befehl in Settings korrigieren
- UI nicht erreichbar: nginx-Status und Firewall prüfen

## Danach weiter

1. [Ersteinrichtung](configuration.md)
2. [Erster Lauf](quickstart.md)
