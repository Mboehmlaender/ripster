# Post-Encode-Skripte

Post-Encode-Skripte ermöglichen es, nach erfolgreichem Encoding automatisch beliebige Shell-Befehle oder Programme auszuführen – z. B. zum Verschieben von Dateien, Benachrichtigen externer Dienste oder Auslösen weiterer Verarbeitungsschritte.

---

## Funktionsweise

Nach einem erfolgreich abgeschlossenen Encoding-Schritt führt Ripster die konfigurierten Skripte **sequenziell** in der festgelegten Reihenfolge aus:

```
ENCODING abgeschlossen
        ↓
Skript 1 ausführen  ← Fehler? → Abbruch
        ↓
Skript 2 ausführen  ← Fehler? → Abbruch
        ↓
        ...
        ↓
FINISHED
```

!!! warning "Abbruch bei Fehler"
    Schlägt ein Skript fehl (Exit-Code ≠ 0), werden alle nachfolgenden Skripte **nicht mehr ausgeführt**.
    Der Job bleibt im Abschlusszustand `FINISHED`; der Fehler wird in Log/Status-Text und im `postEncodeScripts`-Summary festgehalten.

---

## Skript-Verwaltung

Skripte werden über die **Einstellungen-Seite** angelegt und verwaltet. Sie stehen danach in jedem Encode-Review zur Auswahl.

### Skript anlegen

Navigiere zu **Einstellungen → Skripte** und klicke **"Neues Skript"**:

| Feld | Beschreibung |
|------|-------------|
| **Name** | Anzeigename des Skripts (z. B. `Zu Plex verschieben`) |
| **Befehl** | Shell-Befehl oder Skriptpfad (z. B. `/home/michael/scripts/move-to-plex.sh`) |
| **Beschreibung** | Optionale Erklärung |

### Verfügbare Umgebungsvariablen

Jedes Skript wird mit folgenden Umgebungsvariablen aufgerufen:

| Variable | Inhalt | Beispiel |
|---------|--------|---------|
| `RIPSTER_OUTPUT_PATH` | Absoluter Pfad der encodierten Datei | `/mnt/movies/Inception (2010).mkv` |
| `RIPSTER_JOB_ID` | Job-ID in der Datenbank | `42` |
| `RIPSTER_TITLE` | Filmtitel | `Inception` |
| `RIPSTER_YEAR` | Erscheinungsjahr | `2010` |
| `RIPSTER_IMDB_ID` | IMDb-ID | `tt1375666` |
| `RIPSTER_RAW_PATH` | Pfad zur Raw-MKV-Datei | `/mnt/raw/Inception-2010/t00.mkv` |

### Beispiel-Skript: Datei nach Jellyfin verschieben

```bash
#!/bin/bash
# /home/michael/scripts/move-to-jellyfin.sh

TARGET_DIR="/mnt/media/movies"
mkdir -p "$TARGET_DIR"
mv "$RIPSTER_OUTPUT_PATH" "$TARGET_DIR/"
echo "Verschoben: $RIPSTER_TITLE nach $TARGET_DIR"
```

### Beispiel-Skript: Webhook auslösen

```bash
#!/bin/bash
# /home/michael/scripts/notify-webhook.sh

curl -s -X POST https://mein-webhook.example.com/ripster \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"$RIPSTER_TITLE\", \"year\": \"$RIPSTER_YEAR\", \"path\": \"$RIPSTER_OUTPUT_PATH\"}"
```

---

## Skript im Encode-Review auswählen

Im `READY_TO_ENCODE`-Zustand zeigt das **MediaInfoReviewPanel** einen Skript-Abschnitt:

```
┌──────────────────────────────────────────────────────────┐
│ Post-Encode-Skripte                                      │
├──────────────────────────────────────────────────────────┤
│ Ausgewählte Skripte (Reihenfolge per Drag & Drop):       │
│  ≡  1. Zu Plex verschieben                    [Entfernen]│
│  ≡  2. Webhook auslösen                       [Entfernen]│
├──────────────────────────────────────────────────────────┤
│ Skript hinzufügen: [Zu Jellyfin verschieben ▾] [+ Hinzuf.]│
└──────────────────────────────────────────────────────────┘
```

- **Reihenfolge** per Drag & Drop ändern
- **Hinzufügen** aus der Dropdown-Liste aller konfigurierten Skripte
- **Entfernen** einzelner Skripte aus der aktuellen Auswahl
- Skripte können pro Job unterschiedlich gewählt werden

---

## Skript testen

Über die Einstellungen kann jedes Skript mit einem Test-Job ausgeführt werden:

```http
POST /api/settings/scripts/:scriptId/test
```

Der Test-Aufruf befüllt die Umgebungsvariablen mit Platzhalter-Werten.

---

## Ausführungs-Ergebnis

Das Ergebnis der Skript-Ausführung wird im Job-Datensatz gespeichert und in der History angezeigt:

```json
{
  "postEncodeScripts": {
    "configured": 2,
    "attempted": 2,
    "succeeded": 2,
    "failed": 0,
    "skipped": 0,
    "aborted": false,
    "results": [
      {
        "scriptId": 1,
        "scriptName": "Zu Plex verschieben",
        "status": "SUCCESS"
      },
      {
        "scriptId": 2,
        "scriptName": "Webhook auslösen",
        "status": "SUCCESS"
      }
    ]
  }
}
```

| Feld | Beschreibung |
|------|-------------|
| `configured` | Anzahl ausgewählter Skripte |
| `attempted` | Anzahl tatsächlich gestarteter Skripte |
| `succeeded` | Erfolgreich ausgeführt (Exit-Code 0) |
| `failed` | Fehlgeschlagen |
| `skipped` | Nicht ausgeführt (wegen vorherigem Fehler) |
| `aborted` | `true`, wenn die Kette abgebrochen wurde |

---

## API-Referenz

Eine vollständige API-Dokumentation der Skript-Endpunkte findest du unter:

[:octicons-arrow-right-24: Settings API – Skripte](../api/settings.md#skript-verwaltung)
