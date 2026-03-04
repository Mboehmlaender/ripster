# Playlist-Analyse

Einige Blu-rays verwenden **Playlist-Obfuskierung** als Kopierschutz. Ripster analysiert automatisch alle MakeMKV-Titel und empfiehlt die korrekte Playlist – auf Basis eines Segment-Scoring-Algorithmus aus `playlistAnalysis.js`.

---

## Das Problem: Playlist-Obfuskierung

Moderne Blu-rays können Dutzende bis Hunderte von Titeln/Playlists enthalten. Der eigentliche Film steckt in genau einer davon – alle anderen sind:

- **Kurze Dummy-Titel** (wenige Sekunden bis Minuten)
- **Titel mit verschachtelten Segmenten** (absichtlich versetzte Reihenfolge, sodass der Film falsch gerippt wird)
- **Titel gleicher Länge** (mehrere Playlists mit identischer Laufzeit, aber unterschiedlicher Segment-Reihenfolge)

Das Ziel der Obfuskierung: Ein einfacher Ripper wählt den erstbesten langen Titel – und bekommt ein zerstückeltes, unbrauchbares Video.

---

## Wann wird die Analyse ausgelöst?

Die Playlist-Analyse wird automatisch gestartet **sobald der Benutzer Metadaten bestätigt** (nach dem Metadaten-Dialog). Ripster ruft `makemkvcon` im Info-Modus auf und parst die TINFO-Ausgabe.

```
TINFO:<titleId>,26,"<segment-list>"
```

Feld **26** enthält die kommagetrennte Liste der Segment-Nummern in der Abspielreihenfolge des Titels.

---

## Algorithmus im Detail (`playlistAnalysis.js`)

### Schritt 1 – Segment-Nummern parsen

```
TINFO:1,26,"00000,00001,00002,00003"  → [0, 1, 2, 3]       linearer Film
TINFO:2,26,"00100,00050,00100,00051"  → [100, 50, 100, 51]  Fake-Playlist
```

### Schritt 2 – Metriken berechnen (`computeSegmentMetrics`)

Für jedes aufeinanderfolgende Segment-Paar `[a, b]` wird `diff = b − a` berechnet:

| Metrik | Bedingung | Bedeutung |
|--------|----------|-----------|
| `directSequenceSteps` | `diff == 1` | Aufeinanderfolgende Segmente → linearer Film |
| `backwardJumps` | `b < a` | Rückwärtssprünge → verdächtig |
| `largeJumps` | `\|diff\| > 20` | Große Sprünge → verdächtig |
| `alternatingPairs` | Große Sprünge mit **wechselndem Vorzeichen** | Hin-und-her-Muster → starker Fake-Indikator |

**Score-Formel:**

```
score = (directSequenceSteps × 2) − (backwardJumps × 3) − (largeJumps × 2)
```

**Konkrete Beispiele:**

| Segmentfolge | directSeq | backward | large | score | Ergebnis |
|-------------|-----------|----------|-------|-------|---------|
| `0,1,2,3,4,5` | 5 | 0 | 0 | +10 | Echter Film |
| `0,1,100,2,101,3` | 2 | 0 | 4 | -4 | Verdächtig |
| `50,10,60,11,70,12` | 0 | 3 | 3 | -15 | Fake |

### Schritt 3 – Bewertungslabel vergeben (`buildEvaluationLabel`)

```
alternatingRatio = alternatingPairs / largeJumps

if alternatingRatio >= 0.55 AND alternatingPairs >= 3:
  → "Fake-Struktur (alternierendes Sprungmuster)"

else if backwardJumps > 0 OR largeJumps > 0:
  → "Auffällige Segmentreihenfolge"

else:
  → "wahrscheinlich korrekt (lineare Segmentfolge)"
```

### Schritt 4 – Duplikat-Gruppen bilden (`buildSimilarityGroups`)

Alle Titel werden nach **ähnlicher Laufzeit** gruppiert (±90 Sekunden Toleranz). Gibt es mehrere Kandidaten mit ähnlicher Laufzeit, ist das ein klares Zeichen für Obfuskierung:

```
8 Titel mit ~148 Minuten Laufzeit → Duplikat-Gruppe
→ obfuscationDetected = true
→ manualDecisionRequired = true
```

### Schritt 5 – Besten Kandidaten empfehlen (`scoreCandidates`)

Innerhalb der größten Duplikat-Gruppe werden alle Kandidaten sortiert nach:

1. `score` (höher = besser)
2. `sequenceCoherence` (Anteil linearer Segmentschritte)
3. Laufzeit (länger = besser)
4. Dateigröße (größer = besser als Tiebreaker)

Der **erste Kandidat** der sortierten Liste ist die Empfehlung.

---

## Wann greift der Benutzer ein?

```
obfuscationDetected    = duplicateDurationGroups.length > 0
manualDecisionRequired = obfuscationDetected
```

| Ergebnis | Nächster Pipeline-Zustand | Aktion |
|---------|--------------------------|--------|
| Keine Duplikat-Gruppen | `READY_TO_START` | Empfehlung wird automatisch übernommen |
| Duplikat-Gruppen gefunden | `WAITING_FOR_USER_DECISION` | Benutzer muss Playlist auswählen |

---

## Benutzeroberfläche: Playlist-Auswahl-Dialog

Wenn `manualDecisionRequired = true`, öffnet sich der Playlist-Dialog **nach** dem Metadaten-Dialog:

```
┌───────────────────────────────────────────────────────────────────┐
│ Playlist-Auswahl                                                  │
├──────────┬──────────┬──────────┬────────────────────────────────┤
│ Playlist │ Laufzeit │  Score   │ Bewertung                       │
├──────────┼──────────┼──────────┼────────────────────────────────┤
│ ★ 00800  │ 2:28:05  │   +18    │ wahrscheinlich korrekt          │
│          │          │          │ (lineare Segmentfolge)          │
├──────────┼──────────┼──────────┼────────────────────────────────┤
│   00801  │ 2:28:12  │    −4    │ Auffällige Segmentreihenfolge   │
├──────────┼──────────┼──────────┼────────────────────────────────┤
│   00900  │ 2:28:05  │   −32    │ Fake-Struktur                   │
│          │          │          │ (alternierendes Sprungmuster)   │
└──────────┴──────────┴──────────┴────────────────────────────────┘
  Hinweis: 847 Playlists insgesamt. 3 relevante Kandidaten (≥ 15 min).
  Empfehlung: 00800 (★)
```

- **★** markiert die empfohlene Playlist (vorausgewählt)
- Nur Titel ≥ `makemkv_min_length_minutes` erscheinen in der Liste
- Der Benutzer wählt per Radio-Button und klickt "Bestätigen"
- Erst nach dieser Bestätigung wechselt die Pipeline zu `READY_TO_START`

---

## Vollständige Datenstruktur (`analyzeContext.playlistAnalysis`)

```json
{
  "titles": [
    { "titleId": 1, "playlistId": "00800", "durationSeconds": 8885, "durationLabel": "2:28:05", "chapters": 28 }
  ],
  "candidates": [
    { "titleId": 1, "playlistId": "00800", "durationSeconds": 8885 },
    { "titleId": 2, "playlistId": "00801", "durationSeconds": 8892 }
  ],
  "evaluatedCandidates": [
    {
      "titleId": 1,
      "playlistId": "00800",
      "score": 18,
      "sequenceCoherence": 0.95,
      "evaluationLabel": "wahrscheinlich korrekt (lineare Segmentfolge)",
      "metrics": {
        "directSequenceSteps": 12,
        "backwardJumps": 0,
        "largeJumps": 1,
        "alternatingPairs": 0
      }
    }
  ],
  "duplicateDurationGroups": [
    [
      { "titleId": 1, "playlistId": "00800" },
      { "titleId": 2, "playlistId": "00801" }
    ]
  ],
  "recommendation": {
    "titleId": 1,
    "playlistId": "00800",
    "score": 18,
    "reason": "Höchster Segment-Score in der größten Laufzeit-Gruppe"
  },
  "obfuscationDetected": true,
  "manualDecisionRequired": true
}
```

---

## Konfiguration

| Einstellung | Standard | Wirkung |
|------------|---------|---------|
| `makemkv_min_length_minutes` | `15` | Titel kürzer als dieser Wert werden als Kandidaten ignoriert |

---

## Tipps bei Fehlempfehlung

!!! tip "Falsche Playlist gewählt?"
    Wenn das resultierende Video zerstückelt ist:

    1. Job in der **History** öffnen
    2. **Re-Encode** starten – diesmal eine andere Playlist wählen
    3. Alternativ: Korrekte Playlist im [MakeMKV-Forum](https://www.makemkv.com/forum/) recherchieren

!!! info "Keine Segment-Daten verfügbar"
    Bei DVDs oder älteren Blu-rays liefert MakeMKV manchmal keine Segmentinfos (TINFO-Feld 26 fehlt). In diesem Fall entfällt die Analyse und der erste Titel über der Mindestlänge wird automatisch verwendet.
