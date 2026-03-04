# Ripster

**Halbautomatische Disc-Ripping-Plattform für DVDs und Blu-rays**

---

<div class="grid cards" markdown>

-   :material-disc: **Automatisiertes Ripping**

    ---

    Disc einlegen – Ripster erkennt sie automatisch und startet den Analyse-Workflow mit MakeMKV.

    [:octicons-arrow-right-24: Workflow verstehen](pipeline/workflow.md)

-   :material-movie-open: **Metadata-Integration**

    ---

    Automatische Suche in der OMDb-Datenbank für Filmtitel, Poster und IMDb-IDs.

    [:octicons-arrow-right-24: Konfiguration](getting-started/configuration.md)

-   :material-cog: **Flexibles Encoding**

    ---

    HandBrake-Encoding mit individueller Track-Auswahl für Audio- und Untertitelspuren.

    [:octicons-arrow-right-24: Encode-Planung](pipeline/encoding.md)

-   :material-history: **Job-Historie**

    ---

    Vollständiges Audit-Trail aller Ripping-Jobs mit Logs und Re-Encode-Funktion.

    [:octicons-arrow-right-24: History API](api/history.md)

</div>

---

## Was ist Ripster?

Ripster ist eine webbasierte Anwendung zur **halbautomatischen Digitalisierung** von DVDs und Blu-rays. Die Anwendung kombiniert bewährte Open-Source-Tools zu einem durchgängigen, komfortablen Workflow:

```
Disc einlegen → Erkennung → Analyse → Metadaten wählen → Rippen → Encodieren → Fertig
```

### Kernfunktionen

| Feature | Beschreibung |
|---------|-------------|
| **Echtzeit-Updates** | WebSocket-basierte Live-Statusanzeige ohne Reload |
| **Intelligente Playlist-Analyse** | Erkennt Blu-ray Playlist-Verschleierung (Fake-Playlists) |
| **Track-Auswahl** | Individuelle Auswahl von Audio- und Untertitelspuren |
| **Orphan-Recovery** | Import von bereits gerippten Dateien als Jobs |
| **PushOver-Benachrichtigungen** | Mobile Alerts bei Fertigstellung oder Fehlern |
| **DB-Korruptions-Recovery** | Automatische Quarantäne bei korrupten SQLite-Dateien |
| **Re-Encoding** | Erneutes Encodieren ohne neu rippen |

---

## Technologie-Stack

=== "Backend"

    - **Node.js** >= 20.19.0 mit Express.js
    - **SQLite3** mit automatischen Schema-Migrationen
    - **WebSocket** (`ws`) für Echtzeit-Kommunikation
    - Externe CLI-Tools: `makemkvcon`, `HandBrakeCLI`, `mediainfo`

=== "Frontend"

    - **React** 18.3.1 mit React Router
    - **Vite** 5.4.12 als Build-Tool
    - **PrimeReact** 10.9.2 als UI-Bibliothek
    - WebSocket-Client für Live-Updates

=== "Externe Tools"

    | Tool | Zweck |
    |------|-------|
    | `makemkvcon` | Disc-Analyse & MKV/Backup-Ripping |
    | `HandBrakeCLI` | Video-Encoding |
    | `mediainfo` | Track-Informationen aus gerippten Dateien |
    | OMDb API | Filmmetadaten (Titel, Poster, IMDb-ID) |

---

## Schnellstart

```bash
# 1. Repository klonen
git clone https://github.com/YOUR_GITHUB_USERNAME/ripster.git
cd ripster

# 2. Starten (Node.js >= 20 erforderlich)
./start.sh

# 3. Browser öffnen
open http://localhost:5173
```

!!! tip "Erste Schritte"
    Die vollständige Installationsanleitung mit allen Voraussetzungen findest du unter [Erste Schritte](getting-started/index.md).

---

## Pipeline-Überblick

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> ANALYZING: Disc erkannt
    ANALYZING --> METADATA_SELECTION: Analyse abgeschlossen
    METADATA_SELECTION --> READY_TO_START: Metadaten bestätigt
    READY_TO_START --> RIPPING: Start gedrückt
    RIPPING --> MEDIAINFO_CHECK: MKV erstellt
    MEDIAINFO_CHECK --> READY_TO_ENCODE: Tracks analysiert
    READY_TO_ENCODE --> ENCODING: Encode bestätigt
    ENCODING --> FINISHED: Encoding fertig
    ENCODING --> ERROR: Fehler
    RIPPING --> ERROR: Fehler
    ERROR --> [*]
    FINISHED --> [*]
```
