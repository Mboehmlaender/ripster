# Schnellstart

Nach der [Installation](installation.md) und [Konfiguration](configuration.md) kannst du sofort mit dem ersten Rip beginnen.

---

## 1. Ripster starten

```bash
cd ripster
./start.sh
```

Öffne [http://localhost:5173](http://localhost:5173) im Browser.

---

## 2. Dashboard

Das Dashboard zeigt den aktuellen Pipeline-Status:

```
Status: IDLE – Bereit
Warte auf Disc...
```

---

## 3. Disc einlegen

Lege eine DVD oder Blu-ray in das Laufwerk ein. Ripster erkennt die Disc automatisch (Polling-Intervall konfigurierbar, Standard: 5 Sekunden) und wechselt in den Status **ANALYZING**.

!!! tip "Manuelle Analyse"
    Falls die Disc nicht automatisch erkannt wird, kann über die API eine manuelle Analyse ausgelöst werden:
    ```bash
    curl -X POST http://localhost:3001/api/pipeline/analyze
    ```

---

## 4. Analyse abwarten

MakeMKV analysiert die Disc-Struktur. Dieser Vorgang dauert je nach Disc **30 Sekunden bis 5 Minuten**.

Der Fortschritt wird live im Dashboard angezeigt.

---

## 5. Metadaten auswählen

Nach der Analyse öffnet sich der **Metadaten-Dialog**:

1. **Titel suchen**: Gib den Filmtitel in die Suchleiste ein
2. **Ergebnis auswählen**: Wähle den passenden Film aus der OMDb-Liste
3. **Playlist wählen** *(nur Blu-ray)*: Bei Blu-rays mit mehreren Playlists zeigt Ripster eine Analyse der wahrscheinlich korrekten Playlist an
4. **Bestätigen**: Klicke auf "Bestätigen"

!!! info "Playlist-Obfuskierung"
    Einige Blu-rays enthalten absichtlich viele Fake-Playlists. Ripster analysiert diese automatisch und schlägt die wahrscheinlich korrekte Playlist vor.

---

## 6. Ripping starten

Nach der Metadaten-Auswahl wechselt der Status zu **READY_TO_START**.

Klicke auf **"Starten"** – MakeMKV beginnt mit dem Ripping.

**Typische Dauer:**
- DVD: 20–40 Minuten
- Blu-ray: 45–120 Minuten

---

## 7. Encode-Review

Nach dem Ripping analysiert MediaInfo die Track-Struktur. Im **Encode-Review** kannst du:

- **Audio-Tracks** auswählen (z. B. Deutsch + Englisch)
- **Untertitel-Tracks** auswählen
- Überflüssige Tracks deaktivieren

Klicke auf **"Encodierung bestätigen"**.

---

## 8. Encoding

HandBrake encodiert die Datei mit dem konfigurierten Preset.

**Fortschrittsanzeige:**
- Aktueller Prozentsatz
- Geschätzte Restzeit (ETA)
- Encoding-Geschwindigkeit (FPS)

---

## 9. Fertig!

Status wechselt zu **FINISHED**. Die encodierte Datei liegt im konfigurierten `movie_dir`.

```
/mnt/nas/movies/
└── Inception (2010).mkv   ← Fertige Datei
```

!!! success "PushOver-Benachrichtigung"
    Falls PushOver konfiguriert ist, erhältst du eine Push-Benachrichtigung auf dein Mobilgerät.

---

## Workflow-Zusammenfassung

```
Disc einlegen
     ↓
ANALYZING (MakeMKV analysiert)
     ↓
METADATA_SELECTION (Titel & Playlist wählen)
     ↓
READY_TO_START → [Starten]
     ↓
RIPPING (MakeMKV rippt)
     ↓
MEDIAINFO_CHECK (Track-Analyse)
     ↓
READY_TO_ENCODE → [Bestätigen]
     ↓
ENCODING (HandBrake encodiert)
     ↓
FINISHED ✓
```

---

## Was tun bei Fehlern?

Falls ein Job in den Status **ERROR** wechselt:

1. Klicke auf **"Details"** im Dashboard
2. Prüfe die Log-Ausgabe
3. Klicke auf **"Retry"** um den Job erneut zu versuchen

Logs findest du auch in der [History-Seite](http://localhost:5173/history).
