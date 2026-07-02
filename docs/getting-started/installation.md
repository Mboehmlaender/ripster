# Installation

Die empfohlene Installation startet immer über `setup.sh`. `setup.sh` lädt das passende `install.sh` aus dem gewünschten Branch und übergibt alle weiteren Parameter unverändert an den eigentlichen Installer.

Wichtig:

- Standard-Einstieg: `setup.sh`
- kein `curl | bash`
- du musst die Tools nicht manuell vorinstallieren, sofern du sie nicht bewusst mit `--no-*` auslässt

## Voraussetzungen

- unterstütztes Linux-System
- Root-Rechte oder `sudo`
- Internetzugang während der Installation

Der Installer erkennt aktuell:

- Debian
- Ubuntu
- Linux Mint
- Pop!_OS

## Standardinstallation

```bash
wget -qO setup.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/setup.sh
bash setup.sh
```

Ohne `--branch` fragt `setup.sh` interaktiv nach dem gewünschten Branch.

Die typischen Branches sind:

- `main`: stabiles Release
- `dev`: aktueller Entwicklungsstand

## Installation mit Branch oder Optionen

Beispiele:

```bash
bash setup.sh --branch main
bash setup.sh --branch dev
bash setup.sh --branch dev --dir /opt/ripster --user ripster --port 3001 --host 192.168.1.10
```

`setup.sh` wertet selbst nur `--branch` aus. Alles andere übernimmt `install.sh`.

## Wichtige Optionen von `install.sh`

| Option | Default | Zweck |
|---|---|---|
| `--branch <branch>` | `dev` | installiert genau diesen Git-Branch |
| `--dir <pfad>` | `/opt/ripster` | Installationsverzeichnis |
| `--user <benutzer>` | `ripster` | Systembenutzer für den Dienst |
| `--port <port>` | `3001` | Backend-Port |
| `--host <hostname|ip>` | automatisch ermittelte Host-IP | Hostname/IP für Webzugriff und CORS |
| `--no-makemkv` | aus | MakeMKV nicht installieren |
| `--no-handbrake` | aus | HandBrake nicht installieren |
| `--no-nginx` | aus | nginx-Setup überspringen |
| `--no-system-deps` | aus | Systemabhängigkeiten nicht nachinstallieren |
| `--accept-makemkv-eula` | aus | MakeMKV-EULA ausdrücklich nichtinteraktiv akzeptieren |
| `--force-license-prompts` | aus | Lizenzabfragen auch bei vorhandenen Tools erneut anzeigen |
| `--reinstall` | aus | bestehende Installation aktualisieren |

## Was der Installer einrichtet

Typischer Ablauf:

1. Betriebssystem, Root-Rechte und Host prüfen
2. Systemabhängigkeiten installieren
3. Node.js 20 sicherstellen
4. optional MakeMKV installieren
5. optional HandBrakeCLI installieren
6. optional nginx konfigurieren
7. Repository nach `--dir` klonen oder aktualisieren
8. Backend-/Frontend-Abhängigkeiten installieren
9. Frontend bauen
10. `backend/.env` und Laufzeitverzeichnisse vorbereiten
11. `ripster-backend.service` anlegen und starten

## Dienst prüfen

```bash
sudo systemctl status ripster-backend
```

Typische Aufrufe im Betrieb:

```bash
sudo journalctl -u ripster-backend -f
sudo systemctl restart ripster-backend
```

## Update einer bestehenden Installation

Standard:

```bash
sudo bash /opt/ripster/install.sh --reinstall
```

Wenn die Installation mit abweichenden Kernparametern eingerichtet wurde, dieselben Parameter wieder mitgeben:

```bash
sudo bash /opt/ripster/install.sh --reinstall --dir /opt/ripster --user ripster --port 3001 --host 192.168.1.10
```

Alternativ kannst du auch erneut über `setup.sh` gehen:

```bash
sudo bash /opt/ripster/setup.sh --reinstall
```

`--reinstall` aktualisiert die Installation, behält aber die persistenten Daten der bestehenden Instanz.

## Danach weiter

1. [Ersteinrichtung](configuration.md)
2. [Erster Lauf](quickstart.md)
