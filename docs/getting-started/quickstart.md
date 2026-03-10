# Schnellstart – Erster kompletter Job

Diese Seite führt durch den typischen ersten Lauf.

---

## 1) Starten

```bash
cd ripster
./start.sh
```

Öffne `http://localhost:5173`.

---

## 2) Disc einlegen

Pipeline wechselt auf `DISC_DETECTED`.

Falls nötig manuell neu scannen:

```bash
curl -X POST http://localhost:3001/api/pipeline/rescan-disc
```

---

## 3) Analyse starten

Klicke im Dashboard auf `Analyse starten`.

Intern:

- Job wird angelegt
- MakeMKV-Analyse läuft (`ANALYZING`)
- UI wechselt in Metadatenauswahl (`METADATA_SELECTION`)

---

## 4) Metadaten bestätigen

Im Dialog:

- OMDb-Ergebnis wählen oder manuell eintragen
- bei Playlist-Abfrage ggf. `selectedPlaylist` wählen

Nach Bestätigung startet Ripster automatisch weiter.

---

## 5) Pipeline-Pfade

Abhängig von Job/RAW-Situation:

- **kein RAW vorhanden** -> `RIPPING`
- **RAW vorhanden** -> `MEDIAINFO_CHECK`
- **mehrdeutige Playlist** -> `WAITING_FOR_USER_DECISION`

Wenn Parallel-Limit erreicht ist, wird der Job in die Queue eingereiht.

---

## 6) Review (`READY_TO_ENCODE`)

Im Review-Panel:

- Titel auswählen (falls mehrere)
- Audio-/Subtitle-Tracks auswählen
- optional User-Preset anwenden
- optional Pre-/Post-Skripte und Ketten hinzufügen

Mit `Encoding starten` wird `confirm-encode` + Start ausgelöst.

---

## 7) Encoding (`ENCODING`)

Während Encoding:

- Live-Fortschritt/ETA über WebSocket
- Pre-Encode-Ausführungen laufen vor HandBrake
- Post-Encode-Ausführungen laufen nach HandBrake

Wichtig:

- Pre-Encode-Fehler -> Job endet in `ERROR`
- Post-Encode-Fehler -> Job kann `FINISHED` bleiben, aber mit Fehlerhinweis im Status/Log

---

## 8) Abschluss (`FINISHED`)

Ergebnis:

- Ausgabe in `movie_dir` (ggf. profilspezifisch)
- Job in Historie sichtbar
- Logs im konfigurierten `log_dir`

---

## Nützliche API-Shortcuts

```bash
# Pipeline-Snapshot
curl http://localhost:3001/api/pipeline/state

# Queue-Snapshot
curl http://localhost:3001/api/pipeline/queue

# Jobs
curl http://localhost:3001/api/history
```
