# Schnellstart – Vollständiger Workflow

Nach der [Installation](installation.md) und [Konfiguration](configuration.md) führt diese Seite Schritt für Schritt durch den ersten Rip – mit allen Details aus dem Code.

---

## Übersicht: Pipeline-Ablauf

<div class="pipeline-steps">
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-idle">●</div>
    <div class="pipeline-step-label">IDLE</div>
    <div class="pipeline-step-sub">Warten</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-idle">1</div>
    <div class="pipeline-step-label">DISC_DETECTED</div>
    <div class="pipeline-step-sub">Disc erkannt</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-running">2</div>
    <div class="pipeline-step-label">METADATA_SELECTION</div>
    <div class="pipeline-step-sub">OMDb &amp; Dialog</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-wait">⚠</div>
    <div class="pipeline-step-label">WAITING_FOR_USER_DECISION</div>
    <div class="pipeline-step-sub">Playlist wählen<br><em>(nur bei Obfusk.)</em></div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-user">3</div>
    <div class="pipeline-step-label">READY_TO_START</div>
    <div class="pipeline-step-sub">Bereit</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-running">4</div>
    <div class="pipeline-step-label">RIPPING</div>
    <div class="pipeline-step-sub">MakeMKV</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-running">5</div>
    <div class="pipeline-step-label">MEDIAINFO_CHECK</div>
    <div class="pipeline-step-sub">HandBrake-Scan</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-user">6</div>
    <div class="pipeline-step-label">READY_TO_ENCODE</div>
    <div class="pipeline-step-sub">Track-Review</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-encode">7</div>
    <div class="pipeline-step-label">ENCODING</div>
    <div class="pipeline-step-sub">HandBrake</div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-encode">8*</div>
    <div class="pipeline-step-label">POST-ENCODE</div>
    <div class="pipeline-step-sub">Skripte<br><em>(innerhalb ENCODING)</em></div>
  </div>
  <div class="pipeline-step">
    <div class="pipeline-step-badge step-done">✓</div>
    <div class="pipeline-step-label">FINISHED</div>
    <div class="pipeline-step-sub">Fertig</div>
  </div>
</div>

**Legende:** <span style="color:#546e7a">● Warten</span> &nbsp;|&nbsp; <span style="color:#1565c0">■ Läuft automatisch</span> &nbsp;|&nbsp; <span style="color:#3949ab">■ Benutzeraktion</span> &nbsp;|&nbsp; <span style="color:#e65100">⚠ Optional</span> &nbsp;|&nbsp; <span style="color:#6a1b9a">■ Encodierung</span> &nbsp;|&nbsp; <span style="color:#2e7d32">✓ Fertig</span>

??? note "Vollständiges Zustandsdiagramm (inkl. Fehler- &amp; Alternativpfade)"

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

        MIC -->|Playlist offen (Backup)| WUD
        WUD -->|Playlist bestätigt| MIC
        WUD -->|Playlist bestätigt,\nnoch kein RAW| RTS

        MIC --> RTE[READY_TO\nENCODE]
        RTE -->|Encoding starten| ENC[ENCODING]

        ENC -->|inkl. Post-Skripte| FIN([FINISHED])
        ENC -->|Fehler| ERR

        ERR([ERROR]) -->|Retry / Cancel| IDLE

        style FIN fill:#e8f5e9,stroke:#66bb6a,color:#2e7d32
        style ERR fill:#ffebee,stroke:#ef5350,color:#c62828
        style WUD fill:#fff8e1,stroke:#ffa726,color:#e65100
        style ENC fill:#f3e5f5,stroke:#ab47bc,color:#6a1b9a
    ```

    </div>

---

## Schritt 1 – Ripster starten

```bash
cd ripster
./start.sh
```

Öffne [http://localhost:5173](http://localhost:5173) im Browser. Das Dashboard zeigt `IDLE`.

---

## Schritt 2 – Disc einlegen → `DISC_DETECTED`

Lege eine DVD oder Blu-ray ein. Der `diskDetectionService` pollt das Laufwerk alle `disc_poll_interval_ms` Millisekunden (Standard: 4 Sekunden).

**Was passiert im Code:**

- `diskDetectionService` emittiert `discInserted` mit Geräteinformationen
- `pipelineService.onDiscInserted()` wird aufgerufen
- Dashboard-Status-Badge zeigt **"Medium erkannt"**
- Status-Text zeigt **"Neue Disk erkannt"**
- Der **"Analyse starten"**-Button wird aktiv

!!! tip "Manuelle Auslösung"
    Falls die automatische Erkennung nicht greift:
    ```bash
    curl -X POST http://localhost:3001/api/pipeline/analyze
    ```

---

## Schritt 3 – Analyse starten → `METADATA_SELECTION`

Klicke auf **"Analyse starten"**.

**Was passiert im Code:**

1. Ein neuer Job-Datensatz wird in der Datenbank angelegt (`status: METADATA_SELECTION`)
2. Ripster versucht, den Titel automatisch aus dem Disc-Label/Modell zu ermitteln
3. Mit diesem erkannten Titel wird sofort eine **OMDb-Suche** ausgelöst
4. Der `MetadataSelectionDialog` öffnet sich im Frontend mit den vorgeladenen Suchergebnissen

**Erkannter Titel:** Der Disc-Label (z. B. `INCEPTION`) wird als Suchbegriff verwendet. Falls kein Label vorhanden, bleibt das Suchfeld leer.

---

## Schritt 4 – Metadaten auswählen (`MetadataSelectionDialog`)

Der Dialog zeigt vorgeladene OMDb-Suchergebnisse. Du kannst:

### 4a) OMDb-Suchergebnis wählen

```
┌─────────────────────────────────────────────────┐
│ Suche: [Inception                          ] 🔍 │
├─────────────────────────────────────────────────┤
│ ▶ Inception (2010)  ·  Movie  ·  tt1375666      │
│   Inception: ...    ·  Series ·  ...             │
├─────────────────────────────────────────────────┤
│                           [Auswahl übernehmen]  │
└─────────────────────────────────────────────────┘
```

- Suche durch Titel anpassen und Enter drücken
- Typ-Filter: `movie` / `series` umschalten möglich
- Einen Eintrag anklicken, dann **"Auswahl übernehmen"**

### 4b) Manuelle Eingabe (ohne OMDb)

Falls kein passendes Ergebnis gefunden wird:
- Titel, Jahr und IMDb-ID manuell eingeben
- OMDb-Poster wird übersprungen

**Was passiert nach Bestätigung:**

Ripster ruft `pipelineService.selectMetadata()` auf und startet den nächsten Schritt automatisch:

- Job wird auf `READY_TO_START` gesetzt (kurzer Übergangszustand)
- Falls bereits RAW vorhanden: direkter Sprung zu `MEDIAINFO_CHECK`
- Falls kein RAW vorhanden: automatischer Start von `RIPPING`
- Wenn bereits andere Jobs laufen, landet der Start stattdessen in der Queue

---

## Schritt 5 – Optional: Playlist-Auswahl → `WAITING_FOR_USER_DECISION`

Dieser Zustand erscheint nur bei mehrdeutigen Blu-ray-Playlists (typisch nach RAW-Analyse im Backup-Modus).

Der **Playlist-Auswahl-Dialog** erscheint **zusätzlich** (nach dem Metadaten-Dialog):

```
┌───────────────────────────────────────────────────────────────┐
│ Playlist-Auswahl                                              │
│ Es wurden mehrere Titel mit ähnlicher Laufzeit gefunden.      │
│ Bitte wähle die korrekte Playlist:                            │
├───────────┬──────────┬────────┬──────────────────────────────┤
│ Playlist  │ Laufzeit │ Score  │ Bewertung                     │
├───────────┼──────────┼────────┼──────────────────────────────┤
│ ● 00800   │ 2:28:05  │  +18   │ wahrscheinlich korrekt        │
│           │          │        │ (lineare Segmentfolge)        │
├───────────┼──────────┼────────┼──────────────────────────────┤
│ ○ 00801   │ 2:28:12  │   −4   │ Auffällige Segmentreihenfolge │
├───────────┼──────────┼────────┼──────────────────────────────┤
│ ○ 00900   │ 2:28:05  │  −32   │ Fake-Struktur                 │
│           │          │        │ (alternierendes Sprungmuster) │
└───────────┴──────────┴────────┴──────────────────────────────┘
  847 Playlists insgesamt · 3 relevante Kandidaten (≥ 15 min)
  Empfehlung: 00800 (vorausgewählt)
                                           [Playlist übernehmen]
```

- Die empfohlene Playlist ist **vorausgewählt** (Checkbox)
- Score und Bewertungslabel helfen bei der Entscheidung
- Nach **"Playlist übernehmen"** setzt Ripster automatisch fort:
  - mit vorhandenem RAW in `MEDIAINFO_CHECK`
  - ohne RAW über `READY_TO_START` weiter Richtung `RIPPING`

!!! info "Scoring-Details"
    Wie die Scores berechnet werden, erklärt die [Playlist-Analyse](../pipeline/playlist-analysis.md)-Seite.

---

## Schritt 6 – Ripping → `RIPPING`

**Vorher prüft Ripster:** Existiert bereits eine Raw-Datei für diesen Job?

- **Ja, Raw-Datei vorhanden** → Direkt zu Schritt 7 (Track-Review), kein erneutes Ripping
- **Nein** → MakeMKV-Ripping startet

Im Standardfall startet Ripster diesen Schritt automatisch nach der Metadaten-Auswahl.
Der Button **"Job starten"** ist hauptsächlich für Sonderfälle sichtbar (z. B. Fallback/Queue).

**Was MakeMKV ausführt (MKV-Modus):**

```bash
makemkvcon mkv disc:0 all /mnt/raw/Inception-2010/ \
  --minlength=900 -r
```

**Was MakeMKV ausführt (Backup-Modus):**

```bash
makemkvcon backup disc:0 /mnt/raw/Inception-2010-backup/ \
  --decrypt -r
```

**Live-Fortschritt** wird aus der MakeMKV-Ausgabe geparst:

```
PRGV:2048,0,65536  → Fortschritt wird berechnet und per WebSocket gesendet
PRGT:5011,0,"Sichern..."  → Aktueller Task-Name
```

**Typische Dauer:**
- DVD: 20–45 Minuten
- Blu-ray: 45–120 Minuten

---

## Schritt 7 – Track-Review → `READY_TO_ENCODE`

Nach dem Ripping, nach Playlist-Übernahme oder direkt bei vorhandenem RAW startet der **HandBrake-Scan**:

```bash
HandBrakeCLI --scan -i <quelle> -t 0
```

Dieser Scan liest alle Tracks aus ohne zu encodieren. Ripster baut daraus den Encode-Plan mit automatischer Vorauswahl:

**Status: `MEDIAINFO_CHECK`** – läuft automatisch, kein Benutzereingriff

Danach öffnet sich das **Encode-Review-Panel** (`READY_TO_ENCODE`):

```
┌─────────────────────────────────────────────────────────────────┐
│ Encode-Review                                                   │
│ Titel: Disc Title 1  ·  Laufzeit: 2:28:05  ·  28 Kapitel       │
├─────────────────────────────────────────────────────────────────┤
│ Audio-Spuren                                                    │
├──────┬─────────────────────────────┬───────────────────────────┤
│  ☑  │ Track 1: English (AC3, 5.1)  │ Copy (ac3)                │
│  ☑  │ Track 2: Deutsch (DTS, 5.1)  │ Fallback Transcode (av_aac)│
│  ☐  │ Track 3: Français (AC3, 2.0) │ Nicht übernommen          │
├──────┴─────────────────────────────┴───────────────────────────┤
│ Untertitel-Spuren                                               │
├──────┬─────────────────────────────┬────────┬──────┬──────────┤
│  ☑  │ Track 1: Deutsch             │ Einbr.☐ │Forc.☐│Default☑ │
│  ☐  │ Track 2: English             │ Einbr.☐ │Forc.☐│Default☐ │
├──────┴─────────────────────────────┴────────┴──────┴──────────┤
│                                  [Encoding starten]            │
└─────────────────────────────────────────────────────────────────┘
```

### Audio-Track-Aktionen verstehen

| Symbol/Text | Bedeutung |
|------------|-----------|
| `Copy (ac3)` | Track wird **verlustfrei** direkt übernommen |
| `Copy (truehd)` | TrueHD-Track wird direkt übernommen |
| `Transcode (av_aac)` | Track wird zu AAC umgewandelt |
| `Fallback Transcode (av_aac)` | Copy nicht möglich → automatisch zu AAC |
| `Preset-Default (HandBrake)` | HandBrake-Preset entscheidet |
| `Nicht übernommen` | Track ist nicht ausgewählt |

### Untertitel-Flags

| Flag | Bedeutung |
|------|-----------|
| **Einbrennen** | Untertitel werden fest ins Video gebrannt (nur ein Track möglich) |
| **Forced** | Nur erzwungene Untertitel-Einblendungen übernehmen |
| **Default** | Diese Spur wird beim Abspielen automatisch aktiviert |

### Vorauswahl-Regeln

Die Tracks mit `☑` wurden nach der Regel aus den Einstellungen automatisch vorausgewählt (`selectedByRule: true`). Die Auswahl kann frei geändert werden.

Klicke **"Encoding starten"** (bzw. im Pre-Rip-Modus **"Backup + Encoding starten"**), um fortzufahren.
Falls die Auswahl noch nicht bestätigt wurde, übernimmt das Frontend die Bestätigung automatisch beim Start.

---

## Schritt 8 – Encoding → `ENCODING`

HandBrake startet mit dem finalisierten Plan:

```bash
HandBrakeCLI \
  -i /dev/sr0 \
  -o "/mnt/movies/Inception (2010).mkv" \
  -t 1 \
  --preset "H.265 MKV 1080p30" \
  -a 1,2 \
  -E copy:ac3,av_aac \
  -s 1 \
  --subtitle-default 1
```

**Live-Fortschritt** wird aus HandBrake-stderr geparst:

```
Encoding: task 1 of 1, 73.50 % (45.23 fps, avg 44.12 fps, ETA 00h12m34s)
```

Das Dashboard zeigt:
- Fortschrittsbalken (0–100 %)
- Aktuelle Encoding-Geschwindigkeit (FPS)
- Geschätzte Restzeit (ETA)

**Typische Dauer (abhängig von CPU/GPU und Preset):**
- Schnelles Preset (`fast`): 0.5× Echtzeit
- Standard-Preset: 1–3× Echtzeit
- Langsames Preset (`slow`): 5–10× Echtzeit

---

## Schritt 9 – Fertig! → `FINISHED`

```
/mnt/nas/movies/
└── Inception (2010).mkv   ✓ Encodierung abgeschlossen
```

- Job-Status in der Datenbank: `FINISHED`
- PushOver-Benachrichtigung (falls konfiguriert)
- Eintrag in der [History](http://localhost:5173/history) mit vollständigen Logs

---

## Fehlerbehandlung

### Job im Status `ERROR`

1. **Dashboard**: Details-Button → Log-Ausgabe prüfen
2. **Retry**: Job vom Fehlerzustand neu starten (behält Metadaten)
3. **History**: Vollständige Logs und Fehlerdetails

### Häufige Fehlerursachen

| Fehler | Ursache | Lösung |
|-------|---------|--------|
| MakeMKV: Lizenzfehler | Abgelaufene Beta-Lizenz | Neue Lizenz im [MakeMKV-Forum](https://www.makemkv.com/forum/viewtopic.php?t=1053) |
| HandBrake: Preset nicht gefunden | Preset-Name falsch | `HandBrakeCLI --preset-list` prüfen |
| Keine Disc erkannt | Laufwerk-Berechtigungen | `sudo chmod a+rw /dev/sr0` |
| Falsches Video (zerstückelt) | Falsche Playlist | Job re-encodieren mit anderer Playlist |
| OMDb: Keine Ergebnisse | API-Key fehlt oder Titel nicht gefunden | Einstellungen prüfen; manuell eingeben |

---

## Kurzübersicht aller Schritte

| # | Status | Benutzeraktion | Was Ripster tut |
|--|--------|---------------|----------------|
| 1 | `IDLE` | Disc einlegen | Disc-Polling erkennt Disc |
| 2 | `DISC_DETECTED` | "Analyse starten" klicken | Job anlegen, OMDb vorsuchen |
| 3 | `METADATA_SELECTION` | Film im Dialog auswählen | Start automatisch einplanen/auslösen |
| 4 | `READY_TO_START` | meist keine | Übergangszustand vor Auto-Start |
| 5 | `RIPPING` | Warten | MakeMKV rippt, Fortschritt streamen |
| 6 | `MEDIAINFO_CHECK` | Warten | HandBrake-Scan, Encode-Plan bauen |
| 7 | `WAITING_FOR_USER_DECISION` (optional) | Playlist manuell wählen | Auf Bestätigung warten |
| 8 | `READY_TO_ENCODE` | Tracks prüfen + "Encoding starten" | Auswahl übernehmen, Start auslösen |
| 9 | `ENCODING` | Warten | HandBrake encodiert, inkl. Post-Skripte |
| 10 | `FINISHED` | — | Datei fertig, Benachrichtigung senden |
