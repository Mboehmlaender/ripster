# Workflow & Zustände

Ripster steuert den Ablauf als Zustandsmaschine.

---

## Zustandsdiagramm (vereinfacht)

```mermaid
flowchart LR
    A[Bereit] --> B[Medium erkannt]
    B --> C[Analyse]
    C --> D[Metadatenauswahl]
    D --> E[Startbereit]
    E --> F[Rippen]
    E --> G[Mediainfo-Pruefung]
    G --> H[Warte auf Auswahl]
    H --> G
    G --> I[Bereit zum Encodieren]
    I --> J[Encodieren]
    J --> K[Fertig]
    J --> L[Fehler]
    F --> L
    F --> M[Abgebrochen]
```

---

## Statusliste (GUI-Anzeige)

| Status in der GUI | Bedeutung |
|---|---|
| `Bereit` | Wartet auf Disc |
| `Medium erkannt` | Disc wurde erkannt |
| `Analyse` | MakeMKV-Analyse läuft |
| `Metadatenauswahl` | Metadaten müssen bestätigt werden |
| `Warte auf Auswahl` | Playlist-Auswahl ist erforderlich |
| `Warte auf Auswahl` | auch für RAW-Entscheidung bei vorhandenen Quelldaten genutzt |
| `Startbereit` | kurzer Übergang vor Start |
| `Rippen` | MakeMKV-Rip läuft |
| `Mediainfo-Pruefung` | Titel/Spuren werden ausgewertet |
| `Bereit zum Encodieren` | Review ist bereit |
| `Encodieren` | HandBrake läuft |
| `CD-Metadatenauswahl` | CD-Metadaten müssen bestätigt werden |
| `CD-Startbereit` | CD-Job wartet auf Start |
| `CD-Analyse` | CD-Track-/Strukturaufbereitung |
| `CD-Rippen` | Audio-CD-Rip läuft |
| `CD-Encodieren` | CD-Encode läuft |
| `Fertig` | erfolgreich abgeschlossen |
| `Abgebrochen` | manuell oder technisch abgebrochen |
| `Fehler` | fehlgeschlagen |

---

## Typische Pfade

### Standardfall (kein vorhandenes RAW)

1. Medium erkannt
2. Analyse + Metadaten
3. Rippen
4. Mediainfo-Pruefung
5. Bereit zum Encodieren
6. Encodieren
7. Fertig

### Vorhandenes RAW

`Startbereit` springt direkt zu `Mediainfo-Pruefung` (kein neuer Rip).

### Mehrdeutige Blu-ray-Playlist

`Mediainfo-Pruefung` -> `Warte auf Auswahl` bis Playlist bestätigt wurde.

### Vorhandenes RAW mit Nutzerentscheidung

`Metadatenauswahl` -> `Warte auf Auswahl` bis Entscheidung für Weiterverarbeitung (`continue`) oder Neustart getroffen wurde.

### CD-Flow

`CD-Metadatenauswahl` -> `CD-Startbereit` -> `CD-Rippen` -> `CD-Encodieren` -> `Fertig`

---

## Queue-Verhalten

Wenn der Wert `Parallele Jobs` erreicht ist:

- neue Starts werden als Queue-Einträge abgelegt
- die Queue kann zusätzlich Nicht-Job-Einträge enthalten (`Skript`, `Kette`, `Warten`)
- Reihenfolge ist per UI/API änderbar

---

## Abbruch, Wiederaufnahme, Neustart

- `Abbrechen`: laufenden Job stoppen oder Queue-Eintrag entfernen
- `Retry Rippen`: Fehler-/Abbruch-Job erneut starten
- `RAW neu encodieren`: aus vorhandenem RAW neu encodieren
- `Review neu starten`: Review aus RAW neu aufbauen
- `Encode neu starten`: Encoding mit letzter bestätigter Auswahl neu starten
