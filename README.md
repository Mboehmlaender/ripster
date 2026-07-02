# Ripster

![Ripster Logo](frontend/public/logo.png)

Ripster ist eine lokale Web-Anwendung für Disc-Ripping, Audiobook-Verarbeitung und Datei-Konvertierung. Das System kombiniert MakeMKV, HandBrake, FFmpeg, `cdparanoia`, `mkvmerge`, SQLite und eine React-Oberfläche zu einer durchgehenden Pipeline mit Queue, Historie, Downloads, Skript-Automation und Echtzeitstatus per WebSocket.

## ⚠️ Rechtlicher Hinweis

Ripster ist ausschließlich für die Sicherung von Titeln gedacht, die dir selbst gehören oder für die du die erforderlichen Nutzungsrechte besitzt. Bitte prüfe vor der Nutzung die in deinem Land geltenden Urheberrechts-, Privatkopie- und Kopierschutzregelungen. Die Software ist nicht für Piraterie oder die Verarbeitung unberechtigt beschaffter Inhalte gedacht.

## KI-unterstützte Entwicklung

Teile dieses Projekts, einschließlich Quellcode, Dokumentation, Tests und konzeptioneller Entwürfe, wurden mit Unterstützung generativer KI erstellt oder überarbeitet.

KI-Werkzeuge wurden insbesondere für Implementierungsvorschläge, Fehleranalyse, Refactoring, Dokumentation und die Ausarbeitung einzelner Funktionen eingesetzt. Auswahl, Anpassung, Integration und Freigabe der Ergebnisse lagen beim Projektverantwortlichen. Die technische und rechtliche Verantwortung für das veröffentlichte Projekt verbleibt beim menschlichen Maintainer.

Trotz manueller Prüfung können Fehler oder unvollständige Annahmen enthalten sein. Entsprechende Hinweise, Issues und Pull Requests sind willkommen.

## 🎬 Funktionsumfang

### 🎞️ Medien-Workflows
- Blu-ray-Ripping und -Encoding
- DVD-Ripping und -Encoding
- Audio-CD-Ripping und -Encoding
- Audiobook-Verarbeitung aus `.aax`
- Datei-Converter für Audio-, Video- und ISO-Dateien

### 📀 Video (Blu-ray / DVD)
- automatische Disc-Erkennung, Rescan einzelner Laufwerke und Live-Status im Ripper
- Metadaten-Suche über TMDB für Filme und Serien
- HandBrake-Review mit Playlist-/Titel-Auswahl, Audio-/Untertitel-Track-Auswahl und Encode-Vorschau
- MakeMKV-Rip mit profilspezifischen Modi und Zusatzargumenten
- HandBrake-Encoding mit User-Presets, offiziellen HandBrake-Presets und Extra-Args
- Serien-Workflows für DVD- und Blu-ray-Discs inkl. Episoden-Zuordnung und Batch-Encoding
- Multipart-Movie-Workflows über mehrere Discs inkl. Merge-Job via `mkvmerge`
- Re-Encode aus RAW, Review-Neustart, Encode-Neustart, Retry und Resume laufender/unterbrochener Jobs

### 🎵 Audio-CD
- TOC-Analyse und Rip mit `cdparanoia`
- MusicBrainz-Suche und Übernahme von Album-/Track-Metadaten
- Track-Auswahl und Ausgabe als FLAC, WAV, MP3, Opus oder Ogg Vorbis
- RAW-Wiederverwendung und CD-Review-/Encode-Neustart aus vorhandenen Daten

### 🎧 Audiobooks

Diese Funktion ist für eine Archivierung von gekauften Titeln. Das System ermittelt keine Activation-Bytes und verweist dafür auf eine externe Seite

- Upload und Verarbeitung von Audible-/AAX-Dateien
- Metadaten- und Kapitelanreicherung über Audnex plus lokale Probe-Daten
- Ausgabe als M4B, MP3 oder FLAC
- Einzeldatei oder kapitelweises Splitten

### 🔄 Converter (Beta)
- Dateibaum und Datei-Explorer für das Converter-RAW-Verzeichnis
- Upload, Ordner anlegen, Umbenennen, Verschieben und Löschen
- Jobs aus Dateiauswahl erzeugen, Dateien bestehenden Jobs zuweisen oder daraus entfernen
- Audio-/Video-Erkennung und automatische RAW-Scans per Polling
- TMDB-Metadatenzuordnung für passende Video-Jobs

Der Converter ist noch nicht vollständig entwickelt und auch noch nicht vollständig geprüft. Er kann verwendet werden, es funktionieren aber ggf. nicht alle Funktionen vollständig!

### 🛠️ Automation, Betrieb und Verwaltung
- Queue mit normalen Jobs sowie zusätzlichen `script`-, `chain`- und `wait`-Einträgen
- Pre-/Post-Encode-Skripte und Skript-Ketten
- Cron-Jobs für Skripte und Ketten inkl. Validierung, Logs und manueller Auslösung
- Download-Queue für ZIP-Archive aus Historienjobs
- Historie mit Detailansicht, Re-Encode, Review-/Encode-Neustart, Retry und Löschfunktionen
- `/database`-Ansicht für Orphan-RAW-Ordner (Import oder Löschen vorhandener RAW-Daten)
- Hardware-Monitoring mit Live-Werten und Verlaufshistorie
- Pushover-Benachrichtigungen für zentrale Pipeline-Ereignisse
- MakeMKV-Betakey-Prüfung/-Übernahme und Cover-Art-Recovery

## 🖥️ Oberfläche

- `Ripper`: Disc-Erkennung, Pipeline-Status, Queue, Review-Dialoge und aktive Jobs
- `Converter`: Dateibaum, Uploads und Converter-Jobs
- `Audiobooks`: AAX-Uploads und Audiobook-Jobs
- `Settings`: Pfade, Tools, Templates, Queue, Monitoring, Notifications, Scripts, Chains, Presets
- `Historie`: abgeschlossene und fehlerhafte Jobs mit Folgeaktionen
- `Downloads`: vorbereitete ZIP-Downloads
- `Database`: Orphan-RAW-Verwaltung (im Expertenmodus)
- Zusatzansichten: `Hardware` und `TMDB Migration`

## 🚀 Installation

Der korrekte Bootstrap läuft über `setup.sh`. `setup.sh` lädt das passende `install.sh` aus dem gewünschten Branch und startet es mit denselben Parametern.

Unterstützte Systeme laut Installer:
- Debian
- Ubuntu

Standardinstallation:

```bash
wget -qO setup.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/setup.sh
bash setup.sh
```

Es gibt 2 Branches: main und dev

main enthält das aktuelle stbale release
dev enthält den aktuellen Stand der Weiterentwicklung

Hinweise:
- `setup.sh` nutzt bei Bedarf `sudo`; root-Rechte und Internetzugang sind erforderlich.
- Ohne `--branch` bietet `setup.sh` lokal eine Branch-Auswahl an.
- Der eigentliche Installer ist `install.sh`; `setup.sh` ist der empfohlene Einstiegspunkt.

Wichtige Standardparameter für den Installationslauf:

Verfügbare Optionen:
- `--branch <branch>`
- `--dir <pfad>`
- `--user <benutzer>`
- `--port <port>`
- `--host <hostname|ip>`
- `--no-makemkv`
- `--no-handbrake`
- `--no-nginx`
- `--no-system-deps`
- `--accept-makemkv-eula`
- `--force-license-prompts`
- `--reinstall`
- `--help`

Was der Installer typischerweise einrichtet:
- Node.js 20
- `ffmpeg`, `ffprobe`, `mediainfo`, `mkvtoolnix`
- CD-Tools (`cdparanoia`, `flac`, `lame`, `opus-tools`, `vorbis-tools`)
- optional MakeMKV
- optional HandBrakeCLI
- optional nginx
- Repository-Checkout bzw. Update
- npm-Abhängigkeiten, Frontend-Build und `ripster-backend`-systemd-Service

> [!NOTE]
> Ripster orchestriert mehrere externe Medientools. Diese Tools bleiben ihren eigenen Lizenzen und Nutzungsbedingungen unterworfen. Siehe [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) für Details.

Mit `--force-license-prompts` werden die MakeMKV-EULA-Abfrage und die
HandBrake-Drittanbieterhinweise auch dann erneut angezeigt, wenn die jeweiligen
Tools bereits installiert sind. `--no-makemkv` und `--no-handbrake` überspringen
weiterhin den jeweils abgewählten Hinweis.

## ♻️ Update

Standard-Update einer bestehenden Installation:

```bash
sudo bash Pfad_zur_Installation/install.sh --reinstall
```

Wenn die Installation mit abweichenden Kernparametern eingerichtet wurde, diese beim Update wieder mitgeben:

```bash
sudo bash Pfad_zur_Installation/install.sh --reinstall --dir /opt/ripster --user ripster --port 3001 --host 192.168.1.10
```

Alternativ kann auch erneut über `setup.sh` gebootstrapped werden:

```bash
sudo bash Pfad_zur_Installation/setup.sh --reinstall
```

`--reinstall` aktualisiert die Installation und behält die persistenten Daten der bestehenden Instanz bei.

## 🧪 Entwicklung

Schnellstart für lokale Entwicklung:

```bash
./start.sh
```

`start.sh` prüft Node.js, installiert fehlende Abhängigkeiten und startet Backend und Frontend im Dev-Modus.

Wichtige npm-Skripte:
- `npm run dev`
- `npm run dev:backend`
- `npm run dev:frontend`
- `npm run build:frontend`
- `npm run start`

## ⚙️ Konfiguration

Die meisten Einstellungen werden in der Weboberfläche unter `Settings` gepflegt und in SQLite gespeichert. Dazu gehören insbesondere:
- Pfade und Output-Templates für Blu-ray, DVD, Serie, CD, Audiobook, Converter, Downloads und Logs
- Tool-Kommandos für MakeMKV, HandBrake, MediaInfo, FFmpeg, FFprobe, `cdparanoia` und `mkvmerge`
- Laufwerksmodus, Disc-Erkennung und Queue-/Parallelisierungsregeln
- Hardware-Monitoring, Logging, Expert Mode und Cover-Art-Recovery
- TMDB-Zugangsdaten, Pushover, Skripte, Skript-Ketten, User-Presets und Preset-Defaults

Zusätzliche Bootstrap-/Override-Variablen:

Backend:
- `PORT`
- `DB_PATH`
- `LOG_DIR`
- `LOG_LEVEL`
- `CORS_ORIGIN`
- `DEFAULT_TEMP_DIR`
- `DEFAULT_RAW_DIR`
- `DEFAULT_MOVIE_DIR`
- `DEFAULT_SERIES_DIR`
- `DEFAULT_CD_DIR`
- `DEFAULT_AUDIOBOOK_RAW_DIR`
- `DEFAULT_AUDIOBOOK_DIR`
- `DEFAULT_DOWNLOAD_DIR`
- `DEFAULT_CONVERTER_RAW_DIR`
- `DEFAULT_CONVERTER_MOVIE_DIR`
- `DEFAULT_CONVERTER_AUDIO_DIR`

Frontend:
- `VITE_API_BASE`
- `VITE_WS_URL`

## 🗂️ Daten, Logs und API

- Standard-DB: `backend/data/ripster.db`
- Standard-Logs: `backend/logs`
- Standard-Outputs liegen relativ zum Datenverzeichnis, sofern in den Settings nichts anderes gesetzt ist.
- Das Schema wird beim Start geprüft und fehlende DB-Elemente werden migriert.

## 📚 Dokumentation

Ausführlichere Dokumentation liegt in `docs/` und veröffentlicht unter:

https://mboehmlaender.github.io/ripster/

## Lizenz

Der von diesem Repository entwickelte Ripster-Quellcode steht unter der GNU General Public License Version 2 oder jeder späteren Version (`GPL-2.0-or-later`).

Ripster enthält eine separat ausführbare HandBrakeCLI-Version für hardwarebeschleunigtes Encoding. Diese mitgelieferte Drittanbieterkomponente bleibt unter der GNU General Public License Version 2 (`GPL-2.0-only`) lizenziert.

Der vollständige korrespondierende Quellcode, Buildskripte, Patches, Prüfsummen und Lizenzhinweise zur mitgelieferten HandBrakeCLI befinden sich unter [`third_party/handbrake/`](third_party/handbrake/).

Weitere Hinweise zu Drittanbieterkomponenten befinden sich in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
