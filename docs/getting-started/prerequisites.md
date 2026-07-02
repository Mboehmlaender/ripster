# Voraussetzungen

Die Voraussetzungen hängen davon ab, ob du Ripster produktiv installieren oder lokal entwickeln willst.

## Produktionsbetrieb mit `setup.sh`

Für den normalen Betrieb brauchst du nur die Basisvoraussetzungen. Die eigentlichen Tools werden vom Installer eingerichtet, sofern du sie nicht bewusst mit `--no-*` überspringst.

### Pflicht

- unterstütztes Linux-System
- Root-Rechte oder `sudo`
- Internetzugang während der Installation
- optisches Laufwerk, wenn du Disc-Workflows nutzen willst

Der Installer unterstützt aktuell:

- Debian
- Ubuntu
- Linux Mint
- Pop!_OS

Standard-Einstieg:

```bash
wget -qO setup.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/setup.sh
bash setup.sh
```

### Laufwerk kurz prüfen

```bash
ls /dev/sr*
lsblk | grep rom
```

### Optional vorab

- TMDb Read Access Token für Film-/Serien-Metadaten
- PushOver-Zugangsdaten für Benachrichtigungen

Beides kann auch erst nach der Installation in `Settings` gesetzt werden.

## Entwicklungsmodus

Wenn du lokal entwickelst (`./start.sh`, `npm run dev`), gelten zusätzliche Voraussetzungen:

- Node.js `>= 20.19.0`
- `makemkvcon`, `HandBrakeCLI`, `mediainfo` im `PATH`

Details: [Entwicklungsumgebung](../deployment/development.md)

## Abschluss-Checkliste

- [ ] Linux + Root/Sudo + Internet vorhanden
- [ ] optisches Laufwerk vorhanden, falls Disc-Ripping genutzt werden soll
- [ ] TMDb/PushOver-Zugangsdaten liegen bereit, falls diese Funktionen sofort genutzt werden sollen
- [ ] im Dev-Modus zusätzlich Node.js und CLI-Tools lokal verfügbar
