# Einstellungsreferenz

Diese Seite beschreibt jedes Feld aus `Settings -> Konfiguration` aus Anwendersicht: was du dort steuerst, wann die Einstellung greift und welchen Einfluss sie auf Review, Queue, Pfade oder Automatisierung hat.

## So liest du diese Seite

- `Standard` nennt den voreingestellten Wert oder den üblichen Leerzustand.
- `Greift in` sagt dir, in welchem Ablauf du die Wirkung besonders merkst.
- `Praxis` erklärt, warum du das Feld im Alltag bewusst setzen solltest.

## Benachrichtigungen

### Expertenmodus
Standard: `Aus`

Der Schalter blendet zusätzliche technische Felder in der gesamten Settings-Oberfläche ein, zum Beispiel für Logging, Polling-Intervalle oder CLI-Feinjustierung. Er wird sofort gespeichert und wirkt ohne extra Speichern der ganzen Seite.

Greift in:
- die Sichtbarkeit von Expertenfeldern in `Settings`
- zusätzliche Navigations- und Wartungsbereiche

Praxis:
- Aktiviere ihn, wenn du Ripster genauer steuern oder Fehler analysieren willst.
- Lass ihn aus, wenn die Oberfläche bewusst schlank bleiben soll.

### PushOver aktiviert
Standard: `Aus`

Das ist der Master-Schalter für alle PushOver-Nachrichten. Ist er aus, sendet Ripster unabhängig von den einzelnen Ereignis-Toggles nichts.

Greift in:
- Push-Benachrichtigungen zu Auswahl, Start, Erfolg, Fehler und Re-Encode

Praxis:
- Aktiviere den Schalter nur zusammen mit gültigem Token und User-Key.

### PushOver Token
Standard: `leer`

Hier hinterlegst du den Application Token deiner PushOver-Anwendung. Ohne diesen Wert kann Ripster keine Nachricht zustellen.

Greift in:
- jeden PushOver-Versand

Praxis:
- Der Wert stammt aus deiner PushOver-App-Konfiguration.

### PushOver User
Standard: `leer`

Hier steht der User-Key des PushOver-Kontos, an das Ripster senden soll.

Greift in:
- jeden PushOver-Versand

Praxis:
- Trage hier den Zielaccount ein, der die Meldungen wirklich erhalten soll.

### PushOver Device (optional)
Standard: `leer`

Mit diesem Feld begrenzt du PushOver-Nachrichten auf ein bestimmtes Gerät. Bleibt es leer, gehen die Nachrichten an alle Geräte des PushOver-Users.

Greift in:
- die Zielauswahl beim Versand

Praxis:
- Sinnvoll, wenn Ripster nur ein bestimmtes Telefon oder Tablet benachrichtigen soll.

### PushOver Titel-Präfix
Standard: `Ripster`

Das Präfix wird vor den eigentlichen Titel jeder PushOver-Nachricht gesetzt. So kannst du mehrere Instanzen oder Systeme leichter auseinanderhalten.

Greift in:
- die Betreffzeile aller PushOver-Nachrichten

Praxis:
- Typische Werte sind zum Beispiel `Ripster Keller`, `Wohnzimmer-Ripper` oder der Hostname.

### PushOver Priority
Standard: `0`

Die Priorität steuert, wie dringend PushOver die Nachricht behandelt. Niedrigere Werte sind leiser, höhere Werte auffälliger.

Greift in:
- die Zustellungsart auf der PushOver-Seite

Praxis:
- Für normale Statusmeldungen reicht meist `0`.
- Höhere Prioritäten sind eher für Fehler oder manuelle Eingriffe gedacht.

### PushOver Timeout (ms)
Standard: `7000`

Dieser Wert legt fest, wie lange Ripster auf eine Antwort von PushOver wartet, bevor der Versand als fehlgeschlagen gilt.

Greift in:
- die HTTP-Verbindung zu PushOver

Praxis:
- Ein höherer Wert kann bei langsamen Verbindungen helfen.
- Ein niedrigerer Wert sorgt dafür, dass Hänger schneller abgebrochen werden.

### Bei manueller Auswahl senden
Standard: `An`

Ripster sendet eine Nachricht, wenn ein Job auf eine Benutzerentscheidung wartet, zum Beispiel bei Metadatenauswahl, RAW-Entscheidung, Playlist-Auswahl oder Titelwahl vor dem Review.

Greift in:
- Playlistflow
- RAW-Wiederverwendung
- manuelle Review-Vorbereitung

Praxis:
- Das ist eines der wichtigsten Events, wenn Ripster unbeaufsichtigt laufen soll.

### Bei Rip-Start senden
Standard: `An`

Sendet eine Nachricht in dem Moment, in dem der eigentliche MakeMKV-Rip startet.

Greift in:
- Disc-Workflows im Ripper

Praxis:
- Nützlich, wenn du wissen willst, dass die Wartephase beendet ist und das Laufwerk jetzt wirklich arbeitet.

### Bei Encode-Start senden
Standard: `An`

Sendet eine Nachricht beim Start von HandBrake oder eines anderen Encode-Schritts.

Greift in:
- Film-, Serien-, Converter- und Audiobook-Encodes

Praxis:
- Hilfreich, wenn Rip und Encode auf unterschiedlichen Systemlasten beruhen und du den eigentlichen Rechenstart mitbekommen willst.

### Bei Erfolg senden
Standard: `An`

Sendet eine Nachricht nach erfolgreichem Abschluss eines Jobs.

Greift in:
- alle erfolgreichen Pipeline-Läufe

Praxis:
- Gut für lange Nachtläufe oder Stapelverarbeitung.

### Bei Fehler senden
Standard: `An`

Sendet eine Nachricht, sobald ein Job in einen Fehlerzustand läuft.

Greift in:
- Fehler in Rip, Analyse, Review-Aufbau, Encode oder Folgeaktionen

Praxis:
- Dieses Event sollte in produktiven Umgebungen fast immer aktiv bleiben.

### Bei Abbruch senden
Standard: `An`

Sendet eine Nachricht, wenn ein Job manuell abgebrochen wurde.

Greift in:
- Benutzerabbrüche im laufenden Workflow

Praxis:
- Vor allem nützlich, wenn mehrere Personen mit derselben Instanz arbeiten.

### Bei Re-Encode Start senden
Standard: `An`

Sendet eine Nachricht beim Start eines Re-Encodes aus vorhandenem RAW.

Greift in:
- `RAW neu encodieren`
- `Review neu starten` mit erneutem Encode

Praxis:
- Praktisch, wenn du bestehende RAWs später gesammelt neu verarbeitest.

### Bei Re-Encode Erfolg senden
Standard: `An`

Sendet eine Nachricht, wenn ein Re-Encode erfolgreich abgeschlossen wurde.

Greift in:
- Nachbearbeitung aus der Historie

Praxis:
- Besonders hilfreich bei Korrekturläufen auf Basis alter RAWs.

## Converter

### Erlaubte Datei-Endungen
Standard: `mkv,mp4,m2ts,iso,avi,mov,flac,mp3,aac,wav,m4a,ogg,opus`

Die Liste bestimmt, welche Dateitypen der Converter-Upload akzeptiert und welche Dateien beim Scannen des Converter-Eingangsordners berücksichtigt werden. Die Einträge werden kommagetrennt und ohne Punkt gepflegt.

Greift in:
- Upload im Converter
- manueller Scan
- Auto-Scan

Praxis:
- Entferne Formate, die in deiner Umgebung nie verarbeitet werden sollen.
- Ergänze nur Formate, die Ripster später auch sinnvoll als Job behandeln kann.

### Auto-Scan (Polling)
Standard: `Aus`

Wenn dieser Schalter aktiv ist, scannt Ripster den Converter-Eingangsordner in festen Abständen automatisch neu. Neue oder verschobene Dateien tauchen dann ohne manuellen Klick auf.

Greift in:
- die Dateiansicht des Converters
- automatisches Erkennen externer Dateiimporte

Praxis:
- Sinnvoll, wenn Dateien per Netzfreigabe, Script oder anderer Software in den Converter gelegt werden.

### Polling-Intervall (Sekunden)
Standard: `300`

Der Wert bestimmt, wie oft der Converter-Eingangsordner bei aktivem Auto-Scan geprüft wird.

Greift in:
- Reaktionsgeschwindigkeit des Converter-Scans
- Systemlast durch wiederholte Verzeichnisprüfungen

Praxis:
- Kleinere Werte aktualisieren schneller, erzeugen aber mehr Dateisystemzugriffe.

## Laufwerk

### Laufwerksmodus
Standard: `auto`

Hier legst du fest, ob Ripster optische Laufwerke automatisch erkennen soll oder ob du feste Laufwerke manuell definierst.

Greift in:
- Laufwerkserkennung
- Disc-Monitoring
- Zuordnung von Laufwerk und MakeMKV-Quelle

Praxis:
- `auto` passt für die meisten Einzel-Laufwerke.
- Ein expliziter Modus ist besser, wenn mehrere Laufwerke stabil an bestimmte Geräte gebunden werden sollen.

### Explizite Laufwerke
Standard: `leer`

In diesem Editor legst du pro Laufwerk einen Gerätepfad und den passenden MakeMKV-Index fest. Diese Liste wird nur verwendet, wenn der Laufwerksmodus auf einen expliziten Betrieb gestellt ist.

Greift in:
- Multi-Drive-Setups
- stabile Zuordnung zwischen Linux-Gerät und MakeMKV-Quelle

Praxis:
- Besonders hilfreich bei zwei oder mehr Laufwerken oder bei wechselnden USB-Adaptern.

### Device Pfad
Standard: `/dev/sr0`

Dieses Feld ist normalerweise ausgeblendet und dient nur als älterer Einzelwert für feste Laufwerkskonfigurationen. In der Praxis solltest du stattdessen den Editor `Explizite Laufwerke` verwenden.

Greift in:
- interne Fallbacks bei expliziter Laufwerkskonfiguration

Praxis:
- Nur relevant für Sonderfälle oder Altdaten.

### MakeMKV Source Index
Standard: `0`

Dieses normalerweise ausgeblendete Feld legt den MakeMKV-Quellindex fest, wenn kein expliziter Laufwerks-Eintrag greift.

Greift in:
- interne Quellauflösung für MakeMKV

Praxis:
- Im Alltag wird dieser Wert meist automatisch aus der Laufwerkskonfiguration abgeleitet.

### Automatische Disk-Erkennung
Standard: `An`

Wenn der Schalter aktiv ist, prüft Ripster regelmäßig, ob neue Discs eingelegt wurden. Ist er aus, musst du Laufwerke manuell neu einlesen.

Greift in:
- automatisches Erkennen neu eingelegter Discs

Praxis:
- Deaktiviere die Automatik nur, wenn sie in deiner Umgebung stört oder du volle manuelle Kontrolle willst.

### Polling Intervall (ms)
Standard: `4000`

Der Wert bestimmt, wie häufig Ripster nach neuen oder entfernten Discs sucht.

Greift in:
- Reaktionsgeschwindigkeit der Disc-Erkennung
- Häufigkeit der Laufwerksabfragen

Praxis:
- Ein kleinerer Wert reagiert schneller.
- Ein größerer Wert reduziert die Polling-Last.

### Laufwerk nach Rip auswerfen
Standard: `Aus`

Wenn aktiv, wirft Ripster das beteiligte Laufwerk nach einem erfolgreich abgeschlossenen Rip automatisch aus.

Greift in:
- Disc-Workflows nach erfolgreichem Rip

Praxis:
- Nützlich bei Stapelbetrieb, damit du sofort siehst, welches Laufwerk fertig ist.

## Logging

### Terminal-Ausgabe aktiv
Standard: `An`

Dieser Schalter steuert die Konsolenausgabe des Servers im Terminal. Die Log-Dateien auf Platte bleiben davon unberührt.

Greift in:
- `start.sh`
- Service-Diagnose im Terminal

Praxis:
- Deaktiviere die Ausgabe, wenn die Konsole bewusst ruhig bleiben soll.

### HTTP-Logs im Terminal
Standard: `An`

Zeigt oder unterdrückt eingehende HTTP-Requests in der Konsolenausgabe.

Greift in:
- API-Debugging
- Analyse von Frontend-/Backend-Kommunikation

Praxis:
- Besonders bei Fehlersuche im Webinterface nützlich.

### DEBUG im Terminal
Standard: `An`

Steuert, ob sehr detaillierte Debug-Meldungen im Terminal mitlaufen.

Greift in:
- tiefes Troubleshooting

Praxis:
- Gut für Fehlersuche, oft zu ausführlich für den Dauerbetrieb.

### INFO im Terminal
Standard: `An`

Steuert normale Statusmeldungen in der Konsolenausgabe.

Greift in:
- alltägliche Laufzeitbeobachtung

Praxis:
- Für normale Bedienung meist sinnvoll aktiviert.

### WARN im Terminal
Standard: `An`

Steuert Warnmeldungen in der Konsole.

Greift in:
- Hinweise auf ungewöhnliche, aber nicht sofort kritische Situationen

Praxis:
- Sollte fast immer sichtbar bleiben.

### ERROR im Terminal
Standard: `An`

Steuert Fehlermeldungen in der Konsole.

Greift in:
- alle ernsthaften Laufzeitfehler

Praxis:
- Sollte im Regelfall immer aktiviert bleiben.

## Metadaten

### TMDb Read Access Token
Standard: `leer`

Ohne diesen Token kann Ripster keine reguläre TMDb-Metadatensuche für Filme und Serien durchführen. Der Wert wird für Suche, Zuordnung und spätere Neu-Zuweisungen verwendet.

Greift in:
- Metadatenauswahl nach der Analyse
- Serienzuordnung
- `TMDb neu zuweisen`
- Poster- und Titellookups

Praxis:
- Dieses Feld gehört zu den wichtigsten Grundeinstellungen für Disc-Workflows.

### Film-Sprache
Standard: `de-DE`

Hier legst du fest, in welcher TMDb-Sprache Ripster Titel, Beschreibungen, Staffelnamen und ähnliche Daten zuerst abruft.

Greift in:
- Film- und Serienmetadaten in der Auswahl
- Sprache der zurückgegebenen TMDb-Daten

Praxis:
- Wähle die Sprache, in der du Titel und Episodennamen später auch in Ordnern und Historie sehen willst.

### Fallback Sprache
Standard: `de-DE,en-US`

Wenn in der Hauptsprache keine brauchbaren Daten vorhanden sind, versucht Ripster nacheinander diese Fallback-Sprachen.

Greift in:
- Trefferqualität bei seltenen oder schlecht lokalisierten Titeln

Praxis:
- Eine Kombination aus lokaler Sprache und `en-US` ist oft am robustesten.

### Coverart-Nachladen aktiv
Standard: `An`

Wenn bei Jobs oder Containern Cover fehlen, prüft Ripster in Intervallen automatisch nach und versucht das Material später nachzuladen.

Greift in:
- nachträgliche Pflege von Postern und Covern

Praxis:
- Sinnvoll, wenn beim ersten Lauf gelegentlich noch keine vollständigen Bilder verfügbar waren.

### Coverart-Prüfintervall (Stunden)
Standard: `6`

Legt fest, wie oft die automatische Cover-Prüfung laufen darf.

Greift in:
- Häufigkeit des Cover-Nachladens

Praxis:
- Kleinere Werte aktualisieren schneller, größere Werte reduzieren Hintergrundaktivität.

### NFO nach Encode erzeugen
Standard: `Aus`

Wenn dieser Schalter aktiv ist, legt Ripster nach erfolgreichem Encode eine `.nfo`-Datei neben der finalen Ausgabedatei an.

Greift in:
- Film- und Serienausgabe
- Nachbearbeitung in Media-Centern

Praxis:
- Hilfreich für Setups mit Kodi, Jellyfin-Begleitdateien oder eigener Archivierung.

## Monitoring

### Hardware Monitoring aktiviert
Standard: `An`

Das ist der Master-Schalter für CPU-, RAM-, GPU- und Speicher-Monitoring. Ist er aus, stoppt Ripster Polling und Live-Updates für diese Daten.

Greift in:
- die kompakte Anzeige im `Ripper`
- die Seite `Hardware`

Praxis:
- Deaktiviere das Monitoring nur, wenn du die Werte nicht brauchst oder die Abfragen in deiner Umgebung unerwünscht sind.

### Hardware Monitoring Intervall (ms)
Standard: `5000`

Hier stellst du ein, wie oft Hardware- und Speicherwerte neu ermittelt werden.

Greift in:
- Aktualität der Hardware-Daten
- Polling-Last

Praxis:
- Kürzere Intervalle fühlen sich live an, erzeugen aber mehr Messaufrufe.

## Pfade

### Grundregeln für Pfade, Besitzer und Templates

- Leere Pfadfelder fallen je nach Bereich auf eingebaute Standardpfade oder auf den allgemeineren Profilpfad zurück.
- Besitzer-Felder erwarten `Benutzer:Gruppe` oder `UID:GID`, zum Beispiel `media:media` oder `1000:1000`.
- Wenn ein Besitzer gesetzt ist, versucht Ripster neue oder fertiggestellte Dateien nach dem Schreiben entsprechend zu übernehmen.
- In Templates erzeugt `/` Unterordner.
- Templates greifen immer auf die relative Struktur innerhalb des jeweiligen Zielordners.

### Raw Ausgabeordner (Blu-ray)
Standard: `leer`

Hier landet das von Blu-ray-Discs erzeugte RAW-Material, sofern kein spezieller Serien-RAW-Ordner greift.

Greift in:
- Film- und Disc-Vorbereitung für Blu-ray
- Wiederverwendung vorhandener RAWs

Praxis:
- Lege RAW-Material gern auf ein großes, schnelles Laufwerk.

### Raw Ausgabeordner (DVD)
Standard: `leer`

Hier landet das von DVD-Discs erzeugte RAW-Material, sofern kein spezieller Serien-RAW-Ordner greift.

Greift in:
- DVD-Rip-Phase
- RAW-Wiederverwendung bei DVDs

Praxis:
- Trenne Blu-ray- und DVD-RAW, wenn du unterschiedliche Speicherorte oder Aufbewahrungsstrategien willst.

### CD RAW-Ordner
Standard: `leer`

In diesem Ordner legt Ripster die rohen CD-Dateien aus dem Audio-CD-Rip ab, bevor das endgültige Ausgabeformat erzeugt wird.

Greift in:
- Audio-CD-Rip

Praxis:
- Sinnvoll auf einem lokalen Datenträger mit genug Platz für WAV-Zwischendaten.

### Audiobook RAW-Ordner
Standard: `leer`

Das ist der Basisordner für hochgeladene Audiobook-Quelldateien und deren vorbereitete Rohdaten.

Greift in:
- AAX-Upload
- Audiobook-Vorbereitung

Praxis:
- Gut geeignet für einen Bereich, in dem auch größere temporäre Quelldateien liegen dürfen.

### Serien-Ordner (Blu-ray)
Standard: `leer`

Das ist der Zielordner für fertige Blu-ray-Serienepisoden.

Greift in:
- Ausgabe von Blu-ray-Serien

Praxis:
- Typisch ist eine Trennung von Serien und Filmen auf Verzeichnisebene.

### Film Ausgabeordner (Blu-ray)
Standard: `leer`

Hierhin schreibt Ripster fertige Blu-ray-Filme.

Greift in:
- finale Film-Ausgabe für Blu-ray

Praxis:
- Wenn leer, greift Ripster auf den allgemeinen Film-Output zurück.

### Film Ausgabeordner (DVD)
Standard: `leer`

Hierhin schreibt Ripster fertige DVD-Filme.

Greift in:
- finale Film-Ausgabe für DVD

Praxis:
- Praktisch, wenn DVD- und Blu-ray-Filme getrennt archiviert werden sollen.

### Serien-Ordner (DVD)
Standard: `leer`

Das ist der Zielordner für fertige DVD-Serienepisoden.

Greift in:
- Ausgabe von DVD-Serien

Praxis:
- Kann bewusst getrennt vom Blu-ray-Serienordner geführt werden.

### CD Output-Ordner
Standard: `leer`

Hier landen die final encodierten Audio-CD-Dateien. Wenn das Feld leer ist, nutzt Ripster denselben Bereich wie für die CD-RAW-Daten oder den eingebauten Standard.

Greift in:
- finale Audio-CD-Ausgabe

Praxis:
- Trenne RAW und Ausgabe, wenn du Rohdaten nur kurzfristig behalten willst.

### Audiobook Output-Ordner
Standard: `leer`

Hier landen die fertigen Audiobook-Dateien.

Greift in:
- `m4b`
- kapitelweises `mp3`
- kapitelweises `flac`

Praxis:
- Lege diesen Ordner dort an, wo dein Hörbuch-Archiv liegen soll.

### Download ZIP-Ordner
Standard: `leer`

Ripster erstellt hier vorbereitete ZIP-Downloads aus RAW oder Output und legt auch die zugehörigen Metadateien dort ab.

Greift in:
- Download-Aktionen aus der Historie

Praxis:
- Gut geeignet für einen Bereich mit genug temporärem Platz für Archive.

### Externe Speicher
Standard: `leer`

Hier hinterlegst du zusätzliche Speicherorte, die Ripster in der Oberfläche unter den freien Speichern anzeigen soll. Diese Liste ist für die Überwachung gedacht, nicht als Schreibziel.

Greift in:
- Speicheranzeige im Monitoring

Praxis:
- Nützlich für USB-Platten, NAS-Mounts oder andere Zielmedien, deren freien Platz du im Blick behalten willst.

### Log Ordner
Standard: `installationsabhängig`

Das ist der Basisordner für die Log-Dateien von Ripster. Wenn der Pfad ungültig ist, fällt Ripster auf einen internen Fallback zurück.

Greift in:
- Backend-Logs
- Job-Logs

Praxis:
- Lege Logs auf persistenten Speicher, wenn du Fehlerverläufe langfristig aufbewahren willst.

### CD Output Template
Standard: `{artist} - {album} ({year})/{trackNr} {artist} - {title}`

Dieses Template steuert Ordnerstruktur und Dateinamen der finalen Audio-CD-Ausgabe. Der letzte Abschnitt wird Dateiname, alles davor Unterordner.

Greift in:
- Audio-CD-Ordnerstruktur
- Track-Dateinamen

Praxis:
- Beispiel: Mit dem Standard entsteht typischerweise `Interpret - Album (2024)/01 Interpret - Titel.flac`.

### Output Template (Blu-ray)
Standard: `${title} (${year})/${title} (${year})`

Dieses Template bestimmt Ordner und Dateiname für fertige Blu-ray-Filme.

Greift in:
- finale Blu-ray-Filmausgabe

Praxis:
- Das Standardtemplate erzeugt einen Filmordner und darin eine gleichnamige Datei.

### Output Template (Blu-ray Serie, Episode)
Standard: `{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}`

Dieses Template bestimmt den Pfad für einzelne Blu-ray-Serienfolgen.

Greift in:
- Serien-Workflow mit Einzel-Episoden

Praxis:
- Beispiel: `Serie/Staffel 02/S02E05 - Episodentitel.mkv`.

### Output Template (Blu-ray Serie, Multi-Episode)
Standard: `{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})`

Dieses Template greift, wenn mehrere Folgen in einer Datei zusammengefasst bleiben.

Greift in:
- Serien-Workflow mit Doppelfolgen oder Play-All-Fällen

Praxis:
- So bleibt direkt im Dateinamen sichtbar, dass mehrere Episoden in einer Datei liegen.

### Output Template (DVD)
Standard: `${title} (${year})/${title} (${year})`

Dieses Template bestimmt Ordner und Dateiname für fertige DVD-Filme.

Greift in:
- finale DVD-Filmausgabe

Praxis:
- Das Verhalten entspricht dem Blu-ray-Filmtemplate, nur für das DVD-Profil.

### Output Template (DVD Serie, Episode)
Standard: `{seriesTitle}/Season {seasonNr}/{seriesTitle} - S{seasonNo}E{episodeNo} - {episodeTitle}`

Dieses Template steuert den Pfad für einzelne DVD-Serienfolgen.

Greift in:
- DVD-Serien mit einzelner Episodenausgabe

Praxis:
- Nutze es, um dein bevorzugtes Serien-Schema exakt abzubilden.

### Output Template (DVD Serie, Multi-Episode)
Standard: `{seriesTitle}/Season {seasonNr}/{seriesTitle} - S{seasonNo}E{episodeRange}`

Dieses Template greift für zusammengefasste DVD-Folgen in einer Datei.

Greift in:
- Multi-Episode-Ausgabe im DVD-Serienworkflow

Praxis:
- Besonders relevant bei TV-DVDs mit Play-All-Titeln oder Doppelfolgen.

### Output Template (Audiobook)
Standard: `{author}/{author} - {title} ({year})`

Dieses Template bestimmt den Dateipfad für die Ein-Datei-Ausgabe von Audiobooks, also vor allem für `m4b`.

Greift in:
- Audiobook-Ausgabe als Einzeltitel

Praxis:
- Beispiel: `Autor/Autor - Titel (2023).m4b`.

### Audiobook RAW Template
Standard: `{author} - {title} ({year})`

Dieses Template steuert den Namen des relativen RAW-Unterordners, in den die Audiobook-Quelldaten gelegt werden.

Greift in:
- Audiobook-Upload und RAW-Ablage

Praxis:
- Es hilft dabei, AAX-Rohdaten sauber nach Titel und Jahr zu organisieren.

### Converter Raw-Ordner
Standard: `leer`

Das ist der Eingangsordner des Converters. Uploads, neue Unterordner und externe Dateiimporte landen hier.

Greift in:
- gesamte Converter-Dateiverwaltung

Praxis:
- Dieser Ordner sollte gut erreichbar und groß genug für Rohdateien sein.

### Converter Ausgabe (Video)
Standard: `leer`

Hierhin schreibt Ripster final konvertierte Video- oder ISO-Ergebnisse aus dem Converter.

Greift in:
- Converter-Videojobs

Praxis:
- Lege hier den Zielbereich für fertige Video-Transcodes fest.

### Converter Ausgabe (Audio)
Standard: `leer`

Hierhin schreibt Ripster die finalen Audio-Ergebnisse aus dem Converter.

Greift in:
- Converter-Audiojobs

Praxis:
- Sinnvoll getrennt vom Video-Ausgabeordner.

### Output-Template (Video)
Standard: `{title}`

Dieses Template bestimmt den Dateinamen von Converter-Videojobs. Unterordner sind ebenfalls möglich.

Greift in:
- Converter-Videoausgabe

Praxis:
- Beispiel: `{title}/{title}` erzeugt einen Unterordner pro Titel.

### Output-Template (Audio)
Standard: `{artist} - {title}`

Dieses Template bestimmt Dateiname und bei Bedarf Ordnerstruktur von Converter-Audiojobs.

Greift in:
- einzelne Audio-Dateien
- gemeinsame Audio-Jobs
- Ordnerjobs

Praxis:
- Bei gemeinsamen Audio-Jobs kann der vordere Teil des Templates als Ordner dienen, der hintere Teil als Track-Schema.

### RAW-Ordner (Blu-ray Serie)
Standard: `leer`

Hier kannst du Blu-ray-Serien-RAW bewusst getrennt vom allgemeinen Blu-ray-RAW ablegen.

Greift in:
- Serien-RAW-Erzeugung bei Blu-ray

Praxis:
- Sinnvoll, wenn Serien deutlich andere Speicher- oder Aufbewahrungsregeln haben als Filme.

### Eigentümer RAW-Ordner (Blu-ray Serie)
Standard: `leer`

Legt den Besitzer für Blu-ray-Serien-RAW fest. Ripster versucht neue Dateien und Ordner nach dem Schreiben entsprechend zu übernehmen.

Greift in:
- Dateirechte auf Serien-RAW

Praxis:
- Typisch für NAS-Freigaben oder Docker-Setups mit getrennten Nutzern.

### Eigentümer Raw-Ordner (Blu-ray)
Standard: `leer`

Legt den Besitzer für allgemeine Blu-ray-RAW-Daten fest.

Greift in:
- Dateirechte auf Blu-ray-RAW

Praxis:
- Relevant, wenn der Ripster-Dienst nicht als Zielnutzer schreiben soll.

### RAW-Ordner (DVD Serie)
Standard: `leer`

Hier kannst du DVD-Serien-RAW getrennt vom allgemeinen DVD-RAW ablegen.

Greift in:
- Serien-RAW-Erzeugung bei DVD

Praxis:
- Sinnvoll, wenn Serienmaterial getrennt verwaltet werden soll.

### Eigentümer RAW-Ordner (DVD Serie)
Standard: `leer`

Legt den Besitzer für DVD-Serien-RAW fest.

Greift in:
- Dateirechte auf DVD-Serien-RAW

Praxis:
- Besonders wichtig in Mehrbenutzer- oder NAS-Umgebungen.

### Eigentümer Raw-Ordner (DVD)
Standard: `leer`

Legt den Besitzer für allgemeine DVD-RAW-Daten fest.

Greift in:
- Dateirechte auf DVD-RAW

Praxis:
- Nutze das Feld, wenn finale Rechte nicht beim Service-User liegen sollen.

### Eigentümer CD RAW-Ordner
Standard: `leer`

Legt den Besitzer für Rohdaten aus Audio-CD-Rips fest.

Greift in:
- Rechte auf CD-Zwischendaten

Praxis:
- Hilfreich, wenn andere Tools oder Nutzer auf die Rohdaten zugreifen sollen.

### Eigentümer Audiobook RAW-Ordner
Standard: `leer`

Legt den Besitzer für Audiobook-Rohdaten fest.

Greift in:
- Rechte auf AAX- und Vorbereitungsdaten

Praxis:
- Relevant, wenn Audiobook-RAW nicht beim Dienstbenutzer verbleiben soll.

### Eigentümer Converter RAW-Ordner
Standard: `leer`

Legt den Besitzer für Dateien im Converter-Eingangsbereich fest.

Greift in:
- Rechte auf Uploads und importierte Converter-Dateien

Praxis:
- Praktisch, wenn Dateien nach dem Upload auch außerhalb von Ripster bearbeitet werden.

### Eigentümer Serien-Ordner (Blu-ray)
Standard: `leer`

Legt den Besitzer für fertige Blu-ray-Serienausgaben fest.

Greift in:
- finale Rechte auf Blu-ray-Serien

Praxis:
- Sinnvoll für Media-Center-Freigaben.

### Eigentümer Film-Ordner (Blu-ray)
Standard: `leer`

Legt den Besitzer für fertige Blu-ray-Filmdateien fest.

Greift in:
- finale Rechte auf Blu-ray-Filme

Praxis:
- Nutze das Feld, wenn Filme auf einem NAS oder von anderen Diensten gelesen werden.

### Eigentümer Film-Ordner (DVD)
Standard: `leer`

Legt den Besitzer für fertige DVD-Filmdateien fest.

Greift in:
- finale Rechte auf DVD-Filme

Praxis:
- Gleiches Prinzip wie beim Blu-ray-Filmordner, nur für DVD.

### Eigentümer Serien-Ordner (DVD)
Standard: `leer`

Legt den Besitzer für fertige DVD-Serienausgaben fest.

Greift in:
- finale Rechte auf DVD-Serien

Praxis:
- Hilfreich für gemeinsame Medienarchive.

### Eigentümer CD Output-Ordner
Standard: `leer`

Legt den Besitzer der finalen Audio-CD-Ausgabe fest.

Greift in:
- Rechte auf FLAC-, MP3- oder andere CD-Endformate

Praxis:
- Wichtig, wenn Musik später durch andere Anwendungen verwaltet wird.

### Eigentümer Audiobook Output-Ordner
Standard: `leer`

Legt den Besitzer der finalen Audiobook-Dateien fest.

Greift in:
- Rechte auf `m4b`, `mp3` und `flac`

Praxis:
- Sinnvoll für Bibliotheken, die von separaten Diensten gelesen werden.

### Eigentümer Converter Video Output-Ordner
Standard: `leer`

Legt den Besitzer der finalen Converter-Videoausgabe fest.

Greift in:
- Rechte auf konvertierte Video-Dateien

Praxis:
- Nützlich bei geteilten Medienordnern.

### Eigentümer Converter Audio Output-Ordner
Standard: `leer`

Legt den Besitzer der finalen Converter-Audioausgabe fest.

Greift in:
- Rechte auf konvertierte Audio-Dateien

Praxis:
- Hilfreich, wenn Audio-Dateien später von anderen Diensten verschoben oder indiziert werden.

### Eigentümer Download ZIP-Ordner
Standard: `leer`

Legt den Besitzer der erzeugten Download-Archive und Begleitdateien fest.

Greift in:
- Rechte auf ZIP-Downloads aus der Historie

Praxis:
- Besonders relevant, wenn Downloads über Freigaben oder einen anderen Webserver bereitgestellt werden.

### Kapitel Template (Audiobook)
Standard: `{author}/{author} - {title} ({year})/{chapterNr} {chapterTitle}`

Dieses Template steuert die Zielstruktur für kapitelweise Audiobook-Ausgaben wie `mp3` oder `flac`.

Greift in:
- Kapiteldateien im Audiobook-Workflow

Praxis:
- Beispiel: `Autor/Autor - Titel (2023)/01 Kapitelname.mp3`.

## Tools

### Grundregeln für diese Kategorie

- Die Tool-Kommandos sagen Ripster, welches externe Programm gestartet werden soll.
- `Preset` und `Extra Args` bestimmen das Verhalten der jeweiligen CLI.
- Sprach-Review-Felder greifen nur als Vorauswahl in der Review und nur dann, wenn ein Preset nicht bereits selbst eine explizite Trackauswahl erzwingt.

### MakeMKV Kommando
Standard: `makemkvcon`

Hier gibst du den Befehl oder den vollständigen Pfad zur MakeMKV-CLI an.

Greift in:
- Disc-Analyse
- Rip von Blu-ray und DVD

Praxis:
- Trage einen absoluten Pfad ein, wenn das Tool nicht im `PATH` des Dienstes liegt.

### MakeMKV Key
Standard: `leer`

Hier hinterlegst du den Registrierungsschlüssel für MakeMKV. Ripster synchronisiert ihn beim Speichern in die MakeMKV-Konfiguration und kann außerdem den aktuellen Betakey übernehmen.

Greift in:
- MakeMKV-Nutzung ohne Trial-Einschränkungen

Praxis:
- Sinnvoll, wenn die CLI dauerhaft und ohne manuelle Host-Pflege nutzbar bleiben soll.

### Mediainfo Kommando
Standard: `mediainfo`

Hier gibst du den Befehl oder Pfad zu `mediainfo` an.

Greift in:
- Mediainfo-Prüfung
- Review-Aufbau
- Analyse vorhandener Dateien

Praxis:
- Wichtig für alle Workflows, die Track- und Streaminformationen zuverlässig aufbauen sollen.

### Minimale Titellänge (Minuten)
Standard: `60`

Diese Einstellung wirkt doppelt: Ripster hängt den Wert bei der MakeMKV-Analyse als Mindestlänge an, sofern du nicht schon selbst eine explizite Mindestlänge in den Extra-Args gesetzt hast. Zusätzlich markiert Ripster Titel unterhalb dieser Schwelle später im Review als nicht encodierwürdig.

Greift in:
- Titel- und Playlist-Vorfilterung
- Disc-Analyse
- Review-Aufbau

Praxis:
- Ein hoher Wert blendet Bonusmaterial und Trailer aus.
- Ein zu hoher Wert kann aber auch kürzere Haupttitel oder Episoden verdrängen.

### TMDb Runtime-Abzug für Playlistfilter (%)
Standard: `0`

Ripster vergleicht bei problematischen Blu-rays die Disc-Playlists mit der Laufzeit aus TMDb. Dieser Wert wird prozentual von der TMDb-Laufzeit abgezogen und bildet damit eine lockerere Untergrenze für akzeptable Playlist-Kandidaten. Zusätzlich bleibt immer eine Mindesttoleranz von zwei Minuten nach unten erhalten.

Greift in:
- Playlistflow vor der Review
- Kandidatenauswahl bei Hauptfilm-Playlists

Praxis:
- Beispiel: Steht ein Film in TMDb mit 120 Minuten und du trägst `5` ein, arbeitet Ripster für die Kandidatensuche mit rund 114 Minuten als Untergrenze, solange die feste Zweiminuten-Toleranz nicht ohnehin höher wäre.
- Das hilft bei Discs, deren korrekte Hauptfassung etwas kürzer gemeldet wird als in TMDb.

### HandBrake Kommando
Standard: `HandBrakeCLI`

Hier gibst du den Befehl oder Pfad zu `HandBrakeCLI` an.

Greift in:
- alle Video-Encodes
- Re-Encode aus RAW
- Converter-Videojobs

Praxis:
- Bei mehreren HandBrake-Installationen kannst du hier gezielt eine bestimmte Binary verwenden.

### Encode-Neustart: unvollständige Ausgabe löschen
Standard: `An`

Wenn du einen Encode aus der Historie neu startest und der vorherige Lauf nicht erfolgreich war, entfernt Ripster den unvollständigen Output vor dem Neustart automatisch. Erfolgreiche Ausgaben bleiben davon unberührt.

Greift in:
- `Encode neu starten`

Praxis:
- Aktiviert verhindert diese Option, dass alte Teil-Dateien mit dem neuen Lauf kollidieren.

### Parallele Jobs
Standard: `1`

Das ist das allgemeine Startlimit für gleichzeitig laufende Jobs in der Pipeline. Alles darüber wird in die Warteschlange gestellt.

Greift in:
- Ripper
- Converter
- Audiobooks
- Queue-Pumpe im Hintergrund

Praxis:
- Ein höherer Wert erhöht den Durchsatz, belastet aber CPU, I/O und ggf. mehrere Laufwerke stärker.

### Script-Test Timeout (ms)
Standard: `0`

Dieser Wert gilt nur für den Testlauf von Skripten in `Settings`. `0` bedeutet: kein Timeout.

Greift in:
- `Scripte`-Tab
- Tests einzelner Skripte oder Kettenbausteine

Praxis:
- Setze hier einen festen Wert, wenn du hängende Testskripte automatisch abbrechen willst.

### Max. parallele Audio CD Jobs
Standard: `2`

Diese Einstellung begrenzt speziell, wie viele Audio-CD-Jobs gleichzeitig laufen dürfen. Sie wirkt zusätzlich zum allgemeinen Joblimit.

Greift in:
- Audio-CD-Queue
- Start mehrerer CDs hintereinander

Praxis:
- So kannst du mehrere CDs parallel zulassen, ohne den Videobereich freizugeben.

### Max. Encodes gesamt (medienunabhängig)
Standard: `3`

Das ist der harte Deckel für alle gleichzeitig laufenden Encodes zusammen, unabhängig davon, ob sie von Film, Serie, Converter, CD oder Audiobook stammen.

Greift in:
- alle Encode-Starts
- Gesamtlast der Maschine

Praxis:
- Diese Grenze sticht die Einzellimits aus, wenn zu viele Medienarten gleichzeitig starten wollen.

### Audio CDs: Queue-Reihenfolge überspringen
Standard: `Aus`

Wenn aktiviert, dürfen Audio-CD-Jobs vor normalen Film- oder Videojobs starten, auch wenn diese früher in der Queue stehen. Die Parallelitäts- und Gesamtlimits gelten trotzdem weiter.

Greift in:
- Reihenfolge der Queue
- Audio-CD-Durchsatz in gemischten Warteschlangen

Praxis:
- Sinnvoll, wenn CDs schnell abgearbeitet werden sollen und nicht hinter langen Videoencodes hängen bleiben sollen.

### cdparanoia Kommando
Standard: `cdparanoia`

Hier gibst du den Befehl oder Pfad zu `cdparanoia` an.

Greift in:
- Audio-CD-Rip

Praxis:
- Wichtig, wenn `cdparanoia` nicht im Standardpfad des Systems liegt.

### FFmpeg Kommando
Standard: `ffmpeg`

Hier gibst du den Befehl oder Pfad zu `ffmpeg` an.

Greift in:
- Audiobook-Encodes
- Audio-Nachbearbeitung

Praxis:
- Ohne korrektes `ffmpeg` schlagen Audiobook-Ausgaben fehl.

### FFprobe Kommando
Standard: `ffprobe`

Hier gibst du den Befehl oder Pfad zu `ffprobe` an.

Greift in:
- Analyse von Audiobooks
- Kapitel- und Metadatenaufbau

Praxis:
- Ohne `ffprobe` kann Ripster Kapitel und Dateidetails nicht zuverlässig auslesen.

### Mediainfo Extra Args (Blu-ray)
Standard: `leer`

Diese zusätzlichen Argumente hängt Ripster bei Blu-ray-Mediainfo-Aufrufen an den Befehl an.

Greift in:
- Mediainfo-Prüfung für Blu-ray
- Review-Aufbau aus bestehenden Dateien

Praxis:
- Nur für gezielte Spezialfälle anpassen, wenn du das CLI-Verhalten bewusst überschreiben willst.

### MakeMKV Rip Modus (Blu-ray)
Standard: `backup`

Dieses normalerweise ausgeblendete Systemfeld bestimmt, ob Blu-rays als vollständige Disc-Struktur oder direkt als MKV gerippt werden.

Greift in:
- technische RAW-Erzeugung bei Blu-ray

Praxis:
- Für normale Nutzung bleibt dieser Wert unverändert.

### MakeMKV Analyze Extra Args (Blu-ray)
Standard: `leer`

Diese zusätzlichen Argumente werden an den Blu-ray-Analyseaufruf von MakeMKV angehängt.

Greift in:
- Disc-Analyse
- Titel- und Playlist-Erkennung

Praxis:
- Beachte, dass eine selbst gesetzte Mindestlänge in diesen Args die allgemeine Einstellung zur minimalen Titellänge übersteuert.

### MakeMKV Rip Extra Args (Blu-ray)
Standard: `leer`

Diese zusätzlichen Argumente werden an den eigentlichen Blu-ray-Rip angehängt.

Greift in:
- RAW-Erzeugung bei Blu-ray

Praxis:
- Nur anpassen, wenn du das MakeMKV-Verhalten sehr gezielt erweitern oder überschreiben willst.

### HandBrake Preset (Blu-ray)
Standard: `H.264 MKV 1080p30`

Dieses Feld setzt den technischen HandBrake-Standard für Blu-ray-Jobs, sofern im konkreten Job nichts anderes gewählt wird.

Greift in:
- Review-Vorgaben
- Encode-Start bei Blu-ray

Praxis:
- Das Preset ist deine Grundlinie; im Review oder über User-Presets kann später bewusst davon abgewichen werden.

### HandBrake Extra Args (Blu-ray)
Standard: sprach- und codecbezogene Standardargumente

Hier definierst du zusätzliche HandBrake-CLI-Argumente für Blu-ray-Jobs. Sie steuern zum Beispiel Audio-Sprachauswahl, Untertitelvorgaben, Encoder-Profil und Qualitätsparameter.

Greift in:
- finalen HandBrake-Aufruf bei Blu-ray
- Vorauswahl von Audio und Untertiteln

Praxis:
- Diese Einstellung ist sehr mächtig: Ein expliziter Audio- oder Untertitel-Selektor hier kann die separaten Review-Sprachfelder faktisch überstimmen.

### Review Audio-Sprachen (Blu-ray Film)
Standard: `leer`

Hier definierst du, welche Audiosprachen in der Review eines Blu-ray-Films automatisch vorausgewählt werden sollen. Ripster normalisiert übliche Schreibweisen wie `de`, `deu`, `en` oder `eng`.

Greift in:
- `Bereit zum Encodieren` bei Blu-ray-Filmen

Praxis:
- Beispiel: `de, en`.
- Bleibt das Feld leer, entscheidet Ripster stärker aus Preset und vorhandenen Tracks heraus.

### Review UT-Sprachen (Blu-ray Film)
Standard: `leer`

Hier definierst du die Untertitelsprachen, die in der Review eines Blu-ray-Films vorselektiert werden.

Greift in:
- Untertitelvorauswahl im Film-Review

Praxis:
- Gut für feste Standards wie nur Deutsch und Englisch.

### Review Audio-Sprachen (Blu-ray Serie)
Standard: `leer`

Dieses Feld funktioniert wie das Film-Pendant, greift aber nur bei Blu-ray-Serien.

Greift in:
- Audio-Vorauswahl im Serien-Review

Praxis:
- Praktisch, wenn du für Serien andere Sprachregeln als für Filme nutzt.

### Review UT-Sprachen (Blu-ray Serie)
Standard: `leer`

Dieses Feld funktioniert wie das Film-Pendant, greift aber nur bei Blu-ray-Serien.

Greift in:
- Untertitel-Vorauswahl im Serien-Review

Praxis:
- So lassen sich Serien-Defaults getrennt von Film-Defaults pflegen.

### Ausgabeformat (Blu-ray)
Standard: `mkv`

Hier legst du die Dateiendung der finalen Blu-ray-Ausgabe fest.

Greift in:
- finalen Dateinamen
- Containerformat der Ausgabe

Praxis:
- Wähle das Format, das zu deinem Player- oder Archiv-Setup passt.

### Mediainfo Extra Args (DVD)
Standard: `leer`

Diese zusätzlichen Argumente hängen an den Mediainfo-Aufrufen für DVD-Jobs.

Greift in:
- Mediainfo-Prüfung für DVD

Praxis:
- Nur für gezielte technische Sonderfälle anpassen.

### MakeMKV Rip Modus (DVD)
Standard: `mkv`

Dieses normalerweise ausgeblendete Systemfeld legt fest, ob DVDs direkt als MKV oder als Disc-Struktur gerippt werden.

Greift in:
- technische RAW-Erzeugung bei DVD

Praxis:
- Im Normalfall unverändert lassen.

### MakeMKV Analyze Extra Args (DVD)
Standard: `leer`

Diese zusätzlichen Argumente werden an den DVD-Analyseaufruf von MakeMKV angehängt.

Greift in:
- DVD-Titelerkennung
- spätere Review-Vorbereitung

Praxis:
- Wie bei Blu-ray gilt: eigene Mindestlängen-Args können die allgemeine Mindestlänge übersteuern.

### MakeMKV Rip Extra Args (DVD)
Standard: `leer`

Diese zusätzlichen Argumente werden beim eigentlichen DVD-Rip an MakeMKV angehängt.

Greift in:
- RAW-Erzeugung bei DVD

Praxis:
- Nur bewusst ändern, wenn du das CLI-Verhalten genau kennst.

### HandBrake Preset (DVD)
Standard: `H.264 MKV 480p30`

Dieses Feld setzt den technischen HandBrake-Standard für DVD-Jobs.

Greift in:
- Review-Vorgaben
- Encode-Start bei DVD

Praxis:
- Eine gute Basis für DVD kann sich deutlich von Blu-ray unterscheiden, deshalb gibt es ein eigenes Feld.

### HandBrake Extra Args (DVD)
Standard: sprach- und codecbezogene Standardargumente

Hier definierst du die zusätzlichen HandBrake-CLI-Argumente für DVD-Jobs.

Greift in:
- finalen HandBrake-Aufruf bei DVD
- Audio- und Untertitelvorauswahl

Praxis:
- Wie bei Blu-ray können explizite Selektionsargumente in diesen Args separate Review-Sprachfelder aushebeln.

### Review Audio-Sprachen (DVD Film)
Standard: `leer`

Definiert die Audio-Vorauswahl für DVD-Filme in der Review.

Greift in:
- Film-Review bei DVD

Praxis:
- Beispiel: `de, en`.

### Review UT-Sprachen (DVD Film)
Standard: `leer`

Definiert die Untertitel-Vorauswahl für DVD-Filme in der Review.

Greift in:
- Untertitel-Review bei DVD-Filmen

Praxis:
- Gut für feste Disc-Standards in deiner Sammlung.

### Review Audio-Sprachen (DVD Serie)
Standard: `leer`

Definiert die Audio-Vorauswahl für DVD-Serien in der Review.

Greift in:
- Serien-Review bei DVD

Praxis:
- Trenne Serien-Defaults bewusst von Film-Defaults, wenn nötig.

### Review UT-Sprachen (DVD Serie)
Standard: `leer`

Definiert die Untertitel-Vorauswahl für DVD-Serien in der Review.

Greift in:
- Untertitel-Review bei DVD-Serien

Praxis:
- Besonders nützlich bei Serien mit vielen redundanten UT-Spuren.

### Ausgabeformat (DVD)
Standard: `mkv`

Hier legst du die Dateiendung der finalen DVD-Ausgabe fest.

Greift in:
- finalen Dateinamen
- Containerformat der DVD-Ausgabe

Praxis:
- Dieses Feld ist vom Blu-ray-Format getrennt, damit beide Profile unabhängig voneinander arbeiten können.

### mkvmerge Kommando
Standard: `mkvmerge`

Hier gibst du den Befehl oder Pfad zu `mkvmerge` an.

Greift in:
- Multipart-Film-Zusammenführungen

Praxis:
- Relevant, wenn du mehrteilige Filme oder Disc-Splits später in eine zusammenhängende Ausgabe überführen willst.

## Ausgeblendete Felder

Einige technische Systemfelder sind im Schema vorhanden, werden aber im normalen Formular nicht aktiv angeboten oder nur intern benutzt. In der Doku sind sie oben trotzdem erklärt, damit auch Altdaten, API-Fälle und Spezialsetups nachvollziehbar bleiben.
