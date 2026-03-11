# Voraussetzungen

Die Voraussetzungen hängen davon ab, **wie** du Ripster betreibst.

## Produktionsbetrieb mit `install.sh` (Standard)

Für den normalen Betrieb sind nur wenige Punkte vorab nötig.

### Pflicht

- unterstütztes Linux-System (laut Script: Debian, Ubuntu, Linux Mint, Pop!_OS)
- `root`-Rechte
- Internetzugang während der Installation
- optisches Laufwerk für Disc-Betrieb

`install.sh` installiert die benötigten Tools selbst (u. a. Node.js, MakeMKV, HandBrakeCLI, MediaInfo), sofern sie nicht explizit per `--no-*` übersprungen werden.

### Laufwerk kurz prüfen

```bash
ls /dev/sr*
lsblk | grep rom
```

Wenn nötig Rechte setzen (Beispiel):

```bash
sudo chmod a+rw /dev/sr0
```

### Optional vorab

- OMDb API-Key (kann auch nach Installation in den `Settings` gesetzt werden)
- PushOver-Zugangsdaten (optional)

## Entwicklungsmodus (nur für Dev)

Wenn du lokal entwickelst (`./start.sh`, `npm run dev`), gelten zusätzliche Voraussetzungen:

- Node.js >= 20.19.0
- `makemkvcon`, `HandBrakeCLI`, `mediainfo` im `PATH`

Details: [Entwicklungsumgebung](../deployment/development.md)

## Abschluss-Checkliste

- [ ] Produktionsbetrieb: Linux + root + Internet + Laufwerk vorhanden
- [ ] Dev-Modus (nur falls benötigt): Node.js und CLI-Tools verfügbar
