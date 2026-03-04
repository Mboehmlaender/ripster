# Playlist-Analyse

Einige Blu-rays verwenden **Playlist-Obfuskierung** als Kopierschutz-Mechanismus. Ripster erkennt dieses Muster und hilft bei der Auswahl der korrekten Playlist.

---

## Das Problem: Playlist-Obfuskierung

Moderne Blu-rays können Hunderte von Playlists enthalten, von denen nur eine den eigentlichen Film enthält. Die anderen sind:

- **Kurze Dummy-Playlists** (wenige Sekunden bis Minuten)
- **Umgeordnete Segmente** (falsche Reihenfolge der Film-Segmente)
- **Duplizierte Inhalte** (mehrere Playlists mit gleichem Inhalt, verschiedenen Timestamps)

Dies macht es schwierig, die korrekte Playlist manuell zu identifizieren.

---

## Ripsters Analyse-Algorithmus

`playlistAnalysis.js` analysiert alle von MakeMKV erkannten Playlists nach mehreren Kriterien:

### 1. Laufzeit-Matching

Die erwartete Laufzeit (aus OMDb-Metadaten) wird mit der Playlist-Laufzeit verglichen:

```
Filmtitel:    Inception (2010)
OMDb-Laufzeit: 148 Minuten

Playlist 00800.mpls: 148:22 → ✅ Match
Playlist 00801.mpls:   1:23 → ❌ Zu kurz
Playlist 00900.mpls: 148:25 → ✅ Match (Duplikat?)
```

### 2. Titel-Ähnlichkeit

Playlists mit Namen, die dem Filmtitel ähneln, werden bevorzugt.

### 3. Segment-Validierung

Die Playlist-Segmente werden auf logische Reihenfolge geprüft.

### 4. Häufigkeits-Analyse

Bei mehreren Kandidaten: Welche Segment-Kombination kommt am häufigsten vor?

---

## Benutzer-Interface

Wenn Playlist-Obfuskierung erkannt wird, zeigt Ripster im `MetadataSelectionDialog` eine Playlist-Auswahl:

```
┌─────────────────────────────────────────────────────┐
│ Playlist auswählen                                  │
├─────────────────────────────────────────────────────┤
│ ★ 00800.mpls  2:28:05  ✓ Empfohlen (Laufzeit passt) │
│   00801.mpls  0:01:23  Kurz (wahrscheinlich Menü)   │
│   00900.mpls  2:28:12  Mögliche Alternative          │
│   00901.mpls  0:00:45  Kurz                          │
│   ...         ...      ...                           │
├─────────────────────────────────────────────────────┤
│ Hinweis: 847 Playlists gefunden – Analyse empfiehlt │
│ Playlist 00800.mpls als Hauptfilm.                  │
└─────────────────────────────────────────────────────┘
```

---

## Analyse-Ergebnis-Format

```json
{
  "candidates": [
    {
      "playlist": "00800.mpls",
      "duration": "2:28:05",
      "durationSeconds": 8885,
      "score": 0.95,
      "recommended": true,
      "reasons": ["Laufzeit stimmt mit OMDb überein", "Häufigste Segment-Kombination"]
    },
    {
      "playlist": "00900.mpls",
      "duration": "2:28:12",
      "durationSeconds": 8892,
      "score": 0.72,
      "recommended": false,
      "reasons": ["Ähnliche Laufzeit", "Seltene Segment-Kombination"]
    }
  ],
  "totalPlaylists": 847,
  "recommendation": "00800.mpls"
}
```

---

## Manuelle Auswahl

Falls die automatische Empfehlung nicht korrekt ist:

1. Wähle eine andere Playlist aus der Liste
2. Beachte die Laufzeit-Angabe
3. Vergleiche mit der erwarteten Filmlänge (aus OMDb oder Disc-Hülle)

!!! tip "Tipp"
    Bei Blu-rays von bekannten Filmen kannst du die korrekte Playlist oft über Foren wie [MakeMKV-Forum](https://www.makemkv.com/forum/) verifizieren.

---

## Konfiguration

Die Playlist-Analyse ist automatisch aktiv. Einstellbar ist:

| Parameter | Beschreibung |
|----------|-------------|
| `makemkv_min_length_minutes` | Mindestlänge, um als Hauptfilm-Kandidat zu gelten (Standard: 15 Min) |
