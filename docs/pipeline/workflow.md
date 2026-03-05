# Workflow & Zustände

Der Ripping-Workflow von Ripster ist als **State Machine** implementiert. Jeder Zustand hat klar definierte Übergangsbedingungen und Aktionen.

---

## Zustandsdiagramm

<div class="pipeline-diagram">

```mermaid
flowchart LR
    START(( )) --> IDLE

    IDLE -->|Disc erkannt| DD[DISC_DETECTED]
    DD -->|Analyse starten| META[METADATA\nSELECTION]

    META -->|Metadaten übernommen| RTS[READY_TO\nSTART]
    META -->|vorhandenes RAW +\nPlaylist offen| WUD[WAITING_FOR\nUSER_DECISION]

    RTS -->|Auto-Start| RIP[RIPPING]
    RTS -->|Auto-Start mit RAW| MIC[MEDIAINFO\nCHECK]
    RIP -->|MKV fertig| MIC
    RIP -->|Fehler| ERR
    RIP -->|Abbruch| CAN([CANCELLED])

    MIC -->|Playlist offen (Backup)| WUD
    WUD -->|Playlist bestätigt| MIC
    WUD -->|Playlist bestätigt,\nnoch kein RAW| RTS
    MIC --> RTE[READY_TO\nENCODE]
    RTE -->|Encoding starten\n(bestätigt bei Bedarf automatisch)| ENC[ENCODING]

    ENC -->|inkl. Post-Skripte| FIN([FINISHED])
    ENC -->|Fehler| ERR
    ENC -->|Abbruch| CAN

    ERR([ERROR]) -->|Retry / Cancel| IDLE
    CAN -->|Retry / Neu-Analyse| IDLE
    FIN -->|Neue Disc| IDLE

    style FIN fill:#e8f5e9,stroke:#66bb6a,color:#2e7d32
    style ERR fill:#ffebee,stroke:#ef5350,color:#c62828
    style CAN fill:#fff3e0,stroke:#fb8c00,color:#e65100
    style WUD fill:#fff8e1,stroke:#ffa726,color:#e65100
    style ENC fill:#f3e5f5,stroke:#ab47bc,color:#6a1b9a
    style RIP fill:#e3f2fd,stroke:#42a5f5,color:#1565c0
    style MIC fill:#e3f2fd,stroke:#42a5f5,color:#1565c0
```

</div>

---

## UI-Badge-Bezeichnungen

Die Status-Badges im Dashboard verwenden diese Labels:

| State | Badge-Label |
|------|-------------|
| `IDLE` | `Bereit` |
| `DISC_DETECTED` | `Medium erkannt` |
| `METADATA_SELECTION` | `Metadatenauswahl` |
| `WAITING_FOR_USER_DECISION` | `Warte auf Auswahl` |
| `READY_TO_START` | `Startbereit` |
| `RIPPING` | `Rippen` |
| `MEDIAINFO_CHECK` | `Mediainfo-Pruefung` |
| `READY_TO_ENCODE` | `Bereit zum Encodieren` |
| `ENCODING` | `Encodieren` |
| `FINISHED` | `Fertig` |
| `CANCELLED` | `Abgebrochen` |
| `ERROR` | `Fehler` |
| Queue (kein eigener State) | `In der Queue` |

---

## Zustandsbeschreibungen

### IDLE

**Ausgangszustand.** Ripster wartet auf eine Disc.

- `diskDetectionService` pollt das Laufwerk im konfigurierten Intervall
- Bei Disc-Erkennung: automatischer Übergang zu `DISC_DETECTED`
- WebSocket-Event: `DISC_DETECTED`

---

### DISC_DETECTED

**Disc erkannt, wartet auf Benutzeraktion.**

- Dashboard-Badge: **"Medium erkannt"**
- Status-Text: **"Neue Disk erkannt"**
- **"Analyse starten"**-Button wird aktiv
- Kein Prozess läuft noch

**Übergang:** Benutzer klickt "Analyse starten" → `METADATA_SELECTION`

---

### METADATA_SELECTION

**Metadaten-Auswahl läuft.**

1. Job wird erstellt (`status = METADATA_SELECTION`)
2. OMDb-Vorsuche mit erkanntem Disc-Label
3. `MetadataSelectionDialog` öffnet sich mit vorgeladenen Ergebnissen
4. Benutzer wählt Filmtitel (oder gibt manuell ein)
5. Nach Bestätigung wird der Job automatisch für Start/Queue vorbereitet (`selectMetadata` + `startPreparedJob`)

**Übergang (automatisch nach Metadaten-Bestätigung):**

| Ergebnis | Nächster Zustand |
|--------------------|-----------------|
| Kein verwertbares RAW vorhanden | `READY_TO_START` → automatisch `RIPPING` (oder Queue) |
| Verwertbares RAW vorhanden | `READY_TO_START` → automatisch `MEDIAINFO_CHECK` (oder Queue) |
| Vorhandenes RAW + offene Playlist-Entscheidung | `WAITING_FOR_USER_DECISION` |

---

### WAITING_FOR_USER_DECISION

**Playlist-Obfuskierung erkannt – manuelle Auswahl erforderlich.**

!!! info "Neu seit „Skript Integration + UI Anpassungen""
    Dieser Zustand wurde eingeführt, um Blu-rays mit mehreren Playlists ähnlicher Länge korrekt zu behandeln.

- Playlist-Auswahl-Dialog wird im Dashboard angezeigt
- Alle Kandidaten mit Score, Laufzeit und Bewertungslabel
- Empfohlene Playlist ist vorausgewählt
- Benutzer bestätigt mit **"Playlist übernehmen"**
- Tritt häufig nach `MEDIAINFO_CHECK` auf (Backup-Analyse), seltener direkt nach `METADATA_SELECTION` bei vorhandenem RAW

**Darstellung im Dashboard:**

```
┌──────────────────────────────────────────────────────────┐
│ Playlist-Auswahl erforderlich                            │
│ Es wurden mehrere Titel mit ähnlicher Laufzeit gefunden. │
├──────────┬──────────┬────────┬──────────────────────────┤
│ Playlist │ Laufzeit │ Score  │ Bewertung                 │
├──────────┼──────────┼────────┼──────────────────────────┤
│ ● 00800  │ 2:28:05  │  +18   │ wahrscheinlich korrekt    │
│ ○ 00801  │ 2:28:12  │   −4   │ Auffällige Segmentfolge   │
│ ○ 00900  │ 2:28:05  │  −32   │ Fake-Struktur             │
└──────────┴──────────┴────────┴──────────────────────────┘
                              [Playlist übernehmen]
```

**Übergang:** `selectMetadata(jobId, { selectedPlaylist })` setzt die Pipeline automatisch fort:

- mit vorhandenem RAW nach `MEDIAINFO_CHECK`
- ohne RAW über `READY_TO_START` weiter Richtung `RIPPING`

Mehr Details: [Playlist-Analyse](playlist-analysis.md)

---

### READY_TO_START

**Übergangs-/Fallback-Zustand vor dem eigentlichen Start.**

- Wird nach Metadaten-Bestätigung kurz gesetzt
- `startPreparedJob()` wird danach automatisch ausgeführt
- Wenn Parallel-Limit erreicht ist, wird der Start stattdessen in die Queue eingereiht
- **"Job starten"** ist primär für Sonderfälle/Fallback sichtbar

**Sonderfall – RAW-Datei bereits vorhanden:**
Wenn für diesen Job bereits ein verwertbares RAW unter `raw_dir` existiert, wird Ripping übersprungen und direkt `MEDIAINFO_CHECK` gestartet.

**Übergang:** `startPreparedJob(jobId)` → `RIPPING` oder direkt `MEDIAINFO_CHECK`

---

### RIPPING

**MakeMKV rippt die Disc.**

=== "MKV-Modus (Standard)"

    ```bash
    makemkvcon mkv disc:0 all /path/to/raw/ --minlength=900 -r
    ```

    Erstellt MKV-Datei(en) direkt aus den gewählten Titeln.

=== "Backup-Modus"

    ```bash
    makemkvcon backup disc:0 /path/to/raw/backup/ --decrypt -r
    ```

    Erstellt vollständiges Disc-Backup inkl. Menüs.

**Live-Updates** aus MakeMKV-Ausgabe:

```
PRGV:2048,0,65536  → Fortschritt-Berechnung
PRGT:5011,0,"..."  → Aktueller Task-Name
```

**Typische Dauer:** DVD 20–45 min · Blu-ray 45–120 min

---

### MEDIAINFO_CHECK

**HandBrake-Scan und Encode-Plan-Erstellung.**

Dieser Zustand umfasst je nach Quelle mehrere Phasen:

1. Optional: Playlist-Auflösung bei Blu-ray-Backup (inkl. MakeMKV/HandBrake-Zuordnung)
2. **HandBrake-Scan** (`HandBrakeCLI --scan`) auf RAW-Input
3. **Encode-Plan-Erstellung** mit automatischer Track-Vorauswahl

Kein Benutzereingriff – läuft automatisch durch.

**Übergänge:**

- Eindeutige Quelle/Titelwahl möglich → `READY_TO_ENCODE`
- Mehrdeutige Playlist erkannt → `WAITING_FOR_USER_DECISION`

---

### READY_TO_ENCODE

**Encode-Plan bereit.**

Das `MediaInfoReviewPanel` zeigt:

- **Titel-Auswahl** (bei Discs mit mehreren langen Titeln)
- **Audio-Tracks** mit Encoder-Vorschau (Copy/Transcode/Fallback)
- **Untertitel-Tracks** mit Flags (Einbrennen, Forced, Default)
- **Post-Encode-Skripte** – Auswahl und Reihenfolge der auszuführenden Skripte

Im Frontend startet **"Encoding starten"** (bzw. **"Backup + Encoding starten"** im Pre-Rip-Modus) den nächsten Schritt.
Falls die Review noch nicht bestätigt wurde, wird `confirmEncodeReview(...)` automatisch vor dem Start aufgerufen.

**Übergang:** `startPreparedJob(jobId)` → `ENCODING` (oder im Pre-Rip-Fall zuerst `RIPPING`)

---

### ENCODING

**HandBrake encodiert die Datei.**

```bash
HandBrakeCLI \
  -i <quelle> -o <ziel> \
  -t <titelId> \
  --preset "H.265 MKV 1080p30" \
  -a 1,2 -E copy:ac3,av_aac \
  -s 1 --subtitle-default 1
```

**Live-Updates** aus HandBrake-stderr:

```
Encoding: task 1 of 1, 73.50 % (45.23 fps, avg 44.12 fps, ETA 00h12m34s)
```

Post-Encode-Skripte werden innerhalb dieses Zustands sequenziell ausgeführt (kein separater Pipeline-State).

!!! note "Skriptfehler"
    Skriptfehler führen zum Abbruch der Skriptkette, der Job bleibt jedoch im Abschlusszustand `FINISHED` mit entsprechendem Hinweis im Status-Text/Log.

---

### FINISHED

**Job erfolgreich abgeschlossen.**

- Ausgabedatei liegt im konfigurierten `movie_dir`
- Job-Status in Datenbank: `FINISHED`
- PushOver-Benachrichtigung (falls konfiguriert)
- WebSocket-Event: `PIPELINE_STATE_CHANGED` (State `FINISHED`)

---

### CANCELLED

**Job wurde vom Benutzer abgebrochen.**

- Entsteht bei aktivem Abbruch (`/api/pipeline/cancel`) während laufender Phase
- Job-Status in Datenbank: `CANCELLED`
- Im Dashboard stehen danach u. a. `Retry Rippen`, `Review neu starten` oder `Encode neu starten` (kontextabhängig) zur Verfügung

---

### ERROR

**Fehler aufgetreten.**

- Fehlerdetails im Job-Datensatz gespeichert
- Fehler-Logs in History abrufbar
- **Retry**: Neustart vom Fehlerzustand
- **Neu analysieren**: Disc erneut als neuer Job starten

---

## Abbrechen & Retry

### Pipeline abbrechen

```http
POST /api/pipeline/cancel
```

- SIGINT → graceful exit (Timeout: 10 s) → SIGKILL
- Laufender Job landet in `CANCELLED` (oder Queue-Eintrag wird entfernt, falls noch nicht gestartet)

### Job wiederholen

```http
POST /api/pipeline/retry/:jobId
```

- Startet den Job neu in `RIPPING` (oder reiht den Retry in die Queue ein)
- Metadaten bleiben erhalten; Encode-/Scan-Daten werden neu erzeugt

### Re-Encode

```http
POST /api/pipeline/reencode/:jobId
```

- Encodiert bestehende Raw-MKV neu
- Ermöglicht neue Track-Auswahl und andere Skripte
- Kein Ripping erforderlich
