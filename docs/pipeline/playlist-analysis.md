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
| `Minimale Titellaenge (Minuten)` | Mindestlaufzeit für Kandidaten |

Default ist aktuell `60` Minuten.

---

## UI-Verhalten

Bei manueller Entscheidung zeigt das Dashboard Kandidaten inkl. Score/Bewertung und markiert eine Empfehlung.

Nach Bestätigung:

- mit vorhandenem RAW -> zurück zu `Mediainfo-Pruefung`
- ohne RAW -> Startpfad über `Startbereit` / `Rippen`
