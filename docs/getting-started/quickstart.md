# Erster Lauf

Dieser Ablauf führt einen typischen Disc-Job von Erkennung bis fertiger Datei durch.

## 1. Disc erkennen

1. `Ripper` öffnen
2. Disc einlegen
3. auf `Medium erkannt` warten

Prüfen:

- `Disk-Information` zeigt Device, Label und Laufwerksstatus
- falls nicht: `Laufwerk neu lesen`

Relevante Settings:

- `Laufwerksmodus`
- `Automatische Disk-Erkennung`
- `Polling Intervall (ms)`

## 2. Analyse starten

Aktion:

- `Analyse starten`

Erwartung:

- Status `Analyse`
- danach der Metadaten-Dialog

Relevantes Setting:

- `Minimale Titellänge (Minuten)` beeinflusst bereits, welche Titel/Playlists Ripster später als relevant betrachtet

## 3. Metadaten in TMDb bestätigen

Im Dialog:

1. Treffer suchen oder filtern
2. Film oder Serie auswählen
3. bei Serien zusätzlich `Disc-Nummer` setzen
4. `Auswahl übernehmen`

Mögliche Abzweigungen:

- Duplikatfilm: `Übernahme erzwingen` oder `Multipart movie`
- vorhandenes RAW: Entscheidungsdialog `weiterverwenden` oder `neu rippen`

Relevante Settings:

- `TMDb Read Access Token`
- `Film-Sprache`
- `Fallback Sprache`

## 4. RAW- und Playlist-Entscheidungen

Je nach Disc-Situation geht es jetzt unterschiedlich weiter.

### Normalfall

`Startbereit` -> `Rippen` -> `Mediainfo-Prüfung`

### Vorhandenes RAW

Kein neuer Rip, sondern erst eine Entscheidung:

- vorhandenes RAW weiterverwenden
- RAW löschen und Rip neu starten
- bei passenden Film-Konstellationen optional Multipart mit Orphan-RAW

### Playlist- oder Titelauswahl erforderlich

Bei bestimmten Blu-ray-/DVD-Fällen erscheint `Warte auf Auswahl`.

Dann bestätigst du:

- eine Playlist
- oder einen/mehrere HandBrake-Titel

Relevante Settings:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`

## 5. Encode-Review abschließen

Bei `Bereit zum Encodieren` prüfst du:

- Titelwahl
- Audio-Spuren
- Untertitel
- User-Preset oder HandBrake-Preset
- Pre-/Post-Encode-Skripte und Ketten

Dann:

- `Encoding starten`

Relevante Settings:

- `HandBrake Preset` und `HandBrake Extra Args` je Medium
- `Review Audio-Sprachen (...)`
- `Review UT-Sprachen (...)`
- `Ausgabeformat`
- Standard-Zuordnungen unter `Settings -> Encode-Presets`

## 6. Encoding überwachen

Während `Encodieren`:

- Fortschritt/ETA im Ripper
- Queue-Status beobachten
- bei Bedarf `Hardware`-Ansicht öffnen

Relevante Settings:

- `Parallele Jobs`
- `Max. parallele Audio CD Jobs`
- `Max. Encodes gesamt (medienunabhängig)`
- `Hardware Monitoring aktiviert`
- `Hardware Monitoring Intervall (ms)`

## 7. Ergebnis verifizieren

Nach `Fertig`:

1. `Historie` öffnen
2. Jobdetail prüfen
3. Output-Pfad und Log kontrollieren

Kontrollpunkte:

- finale Datei liegt am erwarteten Template-Pfad
- RAW-Ordner ist finalisiert
- optional `.nfo` wurde erzeugt, falls aktiviert

Relevante Settings:

- Film-Output-Templates oder Serien-Templates
- `Serien-Ordner (Blu-ray)` und `Serien-Ordner (DVD)` plus die Episode-/Multi-Episode-Templates
- `NFO nach Encode erzeugen`

## 8. Typische Folgeaktionen

- falsche TMDb-Zuordnung: `TMDb neu zuweisen`
- andere Trackauswahl: `Review neu starten`
- erneuter Encode aus RAW: `RAW neu encodieren`
- gleicher Plan erneut: `Encode neu starten`
- Rip erneut versuchen: `Retry Rippen`
