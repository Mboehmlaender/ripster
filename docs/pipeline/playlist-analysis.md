# Playlist-Analyse

Ripster analysiert bei Blu-ray-ähnlichen Quellen Playlists und fordert bei Mehrdeutigkeit eine manuelle Auswahl an.

---

## Ziel

Erkennen, welche Playlist sehr wahrscheinlich der Hauptfilm ist, statt versehentlich eine Fake-/Dummy-Playlist zu verwenden.

---

## Eingabedaten

Die Analyse basiert auf MakeMKV-Infos (u. a. Playlist-/Segment-Struktur, Laufzeiten, Titelzuordnung).

---

## Auswertung (vereinfacht)

Für Kandidaten werden u. a. berücksichtigt:

- Laufzeit
- Segment-Reihenfolge
- Rückwärtssprünge/große Sprünge
- Kohärenz linearer Segmentfolgen
- Duplikatgruppen mit ähnlicher Laufzeit

Daraus entstehen intern Kandidatenlisten, Bewertungen und eine Empfehlung.

---

## Wann muss der Benutzer entscheiden?

Wenn nach Filterung mehr als ein relevanter Kandidat übrig bleibt, wechselt der Job in der GUI auf:

- `Warte auf Auswahl`

Dann muss eine Playlist bestätigt werden, bevor der Workflow weiterläuft.

---

## Konfigurationseinfluss

| Feld in `Settings` | Wirkung |
|---|---|
| `Minimale Titellänge (Minuten)` | Mindestlaufzeit für Kandidaten aus MakeMKV/Playlist-Analyse |
| `TMDb Runtime-Abzug für Playlistfilter (%)` | lockert bei Bedarf die untere Laufzeitgrenze relativ zur TMDb-Laufzeit, damit leicht kürzere Hauptfassungen Kandidaten bleiben |

Default ist aktuell `60` Minuten.

---

## UI-Verhalten

Bei manueller Entscheidung zeigt der `Ripper` Kandidaten mit:

- Playlist-Datei
- Titel-ID
- Laufzeit
- Score
- Empfehlung
- Segment- und Audio-Vorschau

Nach Bestätigung:

- mit vorhandenem RAW -> zurück zu `Mediainfo-Pruefung`
- ohne RAW -> Startpfad über `Startbereit` / `Rippen`
