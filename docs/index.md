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

<div class="pipeline-diagram">

```mermaid
flowchart LR
    IDLE --> DD[DISC_DETECTED]
    DD --> META[METADATA\nSELECTION]
    META --> RTS[READY_TO\nSTART]
    RTS -->|Auto-Start| RIP[RIPPING]
    RTS -->|Auto-Start mit RAW| MIC
    RIP --> MIC[MEDIAINFO\nCHECK]
    MIC -->|Playlist offen (Backup)| WUD[WAITING_FOR\nUSER_DECISION]
    WUD --> MIC
    MIC --> RTE[READY_TO\nENCODE]
    RTE --> ENC[ENCODING]
    ENC -->|inkl. Post-Skripte| FIN([FINISHED])
    ENC --> ERR([ERROR])
    RIP --> ERR

    style FIN fill:#e8f5e9,stroke:#66bb6a,color:#2e7d32
    style ERR fill:#ffebee,stroke:#ef5350,color:#c62828
    style WUD fill:#fff8e1,stroke:#ffa726,color:#e65100
    style ENC fill:#f3e5f5,stroke:#ab47bc,color:#6a1b9a
```

</div>

`READY_TO_START` ist in der Praxis meist ein kurzer Übergangszustand: der Job wird nach Metadaten-Auswahl automatisch gestartet oder in die Queue eingeplant.
