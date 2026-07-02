# Lizenzierung und Drittanbieter-Software

## Ripster

Der von diesem Repository entwickelte Ripster-Quellcode steht unter der GNU
General Public License Version 2 oder jeder späteren Version
(`GPL-2.0-or-later`).

## Mitgelieferte HandBrakeCLI

Ripster enthält eine separat ausführbare HandBrakeCLI-Datei, weil Systempakete
je nach Distribution nicht alle für Ripster benötigten Hardwarefunktionen
bereitstellen.

Die mitgelieferte HandBrakeCLI bleibt ein eigenständiges Drittanbieterprogramm
unter `GPL-2.0-only`. Ripster startet sie als externen Prozess; der
HandBrake-Code stammt nicht vom Ripster-Projekt.

Buildinformationen, Prüfsummen, Patches und Hinweise zum korrespondierenden
Quellcode liegen im Repository unter:

`third_party/handbrake/`

Der aktuell mitgelieferte Binary-Build enthält FDK-AAC-Hinweise und ist für die
Weiterverteilung als ungeklärt markiert, bis eine rechtliche Prüfung erfolgt
oder ein sauberer Neuaufbau ohne FDK-AAC bereitgestellt wird.

## Weitere Drittanbieter-Software

Ripster kann zusätzliche externe Medientools aufrufen und sich mit externen
Metadaten- und Benachrichtigungsdiensten verbinden.

Siehe `THIRD_PARTY_NOTICES.md` im Repository für die Übersicht.

## KI-unterstützte Entwicklung

Teile von Ripster wurden mit Unterstützung generativer KI-Werkzeuge erstellt
oder überarbeitet. Alle generierten Ergebnisse wurden unter menschlicher
Verantwortung ausgewählt, geprüft, angepasst und integriert.
