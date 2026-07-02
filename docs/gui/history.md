# Historie

`Historie` ist die Kontroll- und Nachbearbeitungsoberfläche für alle bereits angelegten Jobs.

## Hauptansicht

Filter und Arbeitsmittel:

- Suche
- Statusfilter
- Mediumfilter
- Sortierung
- Listen-/Grid-Layout

Jeder Eintrag zeigt auf einen Blick:

- Titel, Jahr, Poster oder Cover
- Status und Zeitstempel
- RAW- und Output-Verfügbarkeit
- Medien- und Containerhinweise

## Detaildialog

Der Detaildialog bündelt:

- Metadaten
- Jobstatus und Fehlertexte
- RAW- und Output-Pfade
- Encode-Plan und Trackauswahl
- ausgeführte Kommandos
- Prozesslog
- verfügbare Folgeaktionen

Bei Seriencontainern und Multipart-Jobs wird container- und child-orientiert dargestellt.

## Nachbearbeitungsaktionen

| Aktion | Typischer Einsatz | Technische Wirkung |
|---|---|---|
| `TMDb neu zuweisen` | falsches Match, anderer Film, andere Staffel | Metadaten werden neu geschrieben; Poster, Jahr und ggf. Ordnername werden best effort aktualisiert |
| `Review neu starten` | neue Track-/Titelbewertung nötig | Review wird aus vorhandenem RAW neu aufgebaut |
| `RAW neu encodieren` | neuer Encode mit vorhandenem RAW | startet Encode ohne neuen Disc-Rip |
| `Encode neu starten` | gleiche bestätigte Auswahl erneut fahren | letzter bestätigter Plan wird geladen |
| `Retry Rippen` | Rip oder Analyse erneut anstoßen | neuer Rip-Lauf inklusive RAW-Phase |

Relevante Settings:

- `Encode-Neustart: unvollständige Ausgabe löschen`
- `NFO nach Encode erzeugen`

## Löschaktionen und Vorschau

Vor dem endgültigen Löschen zeigt Ripster eine Vorschau mit:

- RAW-Kandidaten
- Movie-/Episode-Kandidaten
- Related-Scope für Container, Kinder und verbundene Jobs

Wichtige Punkte:

- Pfade sind selektierbar
- bei mehreren RAW-Kandidaten muss mindestens ein RAW-Pfad gewählt werden
- Schutzlogik verhindert Löschungen außerhalb erlaubter Root-Verzeichnisse

## Serien- und Multipart-Sicht

### Serien

- Container zeigt den aggregierten Zustand der Child-Jobs
- Disk- und Episodenaktionen können child-spezifisch ausgeführt werden
- `Im Ripper öffnen` hilft bei offenen Reviews

### Multipart

- gemeinsamer Container mit Disc-Childs
- Disc-Nummern bleiben pro Child nachvollziehbar
- Delete-Preview kann Related-Pfade gemeinsam auflösen

## Logs sinnvoll nutzen

- `Tail laden` für schnellen Fehlerkontext
- `Vollständiges Log laden` für tiefe Analyse

Empfehlung:

1. erst den Tail prüfen
2. dann die Stelle im Log eingrenzen
3. anschließend die passende Wiederanlauf-Aktion wählen
