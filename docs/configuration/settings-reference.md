# Einstellungsreferenz

Diese Seite listet die Felder so, wie sie in der GUI unter `Settings` angezeigt werden.

Hinweis: Interne Schlüsselnamen werden hier bewusst nicht verwendet. Falls du sie für Integrationen brauchst, nutze die API-Dokumentation.

---

## Profil-System

Viele Felder sind pro Medientyp getrennt vorhanden:

- Blu-ray
- DVD
- Sonstiges

---

## Template-Platzhalter

Datei-/Ordner-Templates unterstützen:

- `${title}`
- `${year}`
- `${imdbId}`

Nicht gesetzte Werte werden zu `unknown`.

---

## Kategorie: Pfade

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `Raw Ausgabeordner` | path | `data/output/raw` |
| `Raw Ausgabeordner (Blu-ray)` | path | `null` |
| `Raw Ausgabeordner (DVD)` | path | `null` |
| `Raw Ausgabeordner (Sonstiges)` | path | `null` |
| `Eigentümer Raw-Ordner (Blu-ray)` | string | `null` |
| `Eigentümer Raw-Ordner (DVD)` | string | `null` |
| `Eigentümer Raw-Ordner (Sonstiges)` | string | `null` |
| `Film Ausgabeordner` | path | `data/output/movies` |
| `Film Ausgabeordner (Blu-ray)` | path | `null` |
| `Film Ausgabeordner (DVD)` | path | `null` |
| `Film Ausgabeordner (Sonstiges)` | path | `null` |
| `Eigentümer Film-Ordner (Blu-ray)` | string | `null` |
| `Eigentümer Film-Ordner (DVD)` | string | `null` |
| `Eigentümer Film-Ordner (Sonstiges)` | string | `null` |
| `Log Ordner` | path | `data/logs` |

---

## Kategorie: Laufwerk

| Feldname in der GUI | Typ | Default | Hinweis |
|---|---|---|---|
| `Laufwerksmodus` | select | `auto` | `Auto Discovery` oder `Explizites Device` |
| `Device Pfad` | path | `/dev/sr0` | relevant bei `Explizites Device` |
| `MakeMKV Source Index` | number | `0` | Disc-Index im Auto-Modus |
| `Polling Intervall (ms)` | number | `4000` | 1000..60000 |

---

## Kategorie: Monitoring

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `Hardware Monitoring aktiviert` | boolean | `true` |
| `Hardware Monitoring Intervall (ms)` | number | `5000` |

---

## Kategorie: Tools (global)

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `MakeMKV Kommando` | string | `makemkvcon` |
| `MakeMKV Key` | string | `null` |
| `Mediainfo Kommando` | string | `mediainfo` |
| `Minimale Titellaenge (Minuten)` | number | `60` |
| `HandBrake Kommando` | string | `HandBrakeCLI` |
| `Encode-Neustart: unvollständige Ausgabe löschen` | boolean | `true` |
| `Parallele Jobs` | number | `1` |

### Blu-ray-spezifisch

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `Mediainfo Extra Args` (Blu-ray) | string | `null` |
| `MakeMKV Rip Modus` (Blu-ray) | select | `backup` |
| `MakeMKV Analyze Extra Args` (Blu-ray) | string | `null` |
| `MakeMKV Rip Extra Args` (Blu-ray) | string | `null` |
| `HandBrake Preset` (Blu-ray) | string | `H.264 MKV 1080p30` |
| `HandBrake Extra Args` (Blu-ray) | string | `null` |
| `Ausgabeformat` (Blu-ray) | select | `mkv` |
| `Dateiname Template` (Blu-ray) | string | `${title} (${year})` |
| `Ordnername Template` (Blu-ray) | string | `null` |

### DVD-spezifisch

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `Mediainfo Extra Args` (DVD) | string | `null` |
| `MakeMKV Rip Modus` (DVD) | select | `mkv` |
| `MakeMKV Analyze Extra Args` (DVD) | string | `null` |
| `MakeMKV Rip Extra Args` (DVD) | string | `null` |
| `HandBrake Preset` (DVD) | string | `H.264 MKV 480p30` |
| `HandBrake Extra Args` (DVD) | string | `null` |
| `Ausgabeformat` (DVD) | select | `mkv` |
| `Dateiname Template` (DVD) | string | `${title} (${year})` |
| `Ordnername Template` (DVD) | string | `null` |

---

## Kategorie: Metadaten

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `OMDb API Key` | string | `null` |
| `OMDb Typ` | select | `movie` |

---

## Kategorie: Benachrichtigungen (PushOver)

| Feldname in der GUI | Typ | Default |
|---|---|---|
| `PushOver aktiviert` | boolean | `false` |
| `PushOver Token` | string | `null` |
| `PushOver User` | string | `null` |
| `PushOver Device (optional)` | string | `null` |
| `PushOver Titel-Präfix` | string | `Ripster` |
| `PushOver Priority` | number | `0` |
| `PushOver Timeout (ms)` | number | `7000` |
| `Bei Metadaten-Auswahl senden` | boolean | `true` |
| `Bei Rip-Start senden` | boolean | `true` |
| `Bei Encode-Start senden` | boolean | `true` |
| `Bei Erfolg senden` | boolean | `true` |
| `Bei Fehler senden` | boolean | `true` |
| `Bei Abbruch senden` | boolean | `true` |
| `Bei Re-Encode Start senden` | boolean | `true` |
| `Bei Re-Encode Erfolg senden` | boolean | `true` |
