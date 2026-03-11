# Voraussetzungen

Diese Seite ist die praktische Checkliste vor der Installation.

## 1) System

| Punkt | Mindestwert | Empfehlung |
|---|---|---|
| Betriebssystem | Linux oder macOS | Ubuntu 22.04+ |
| Node.js | 20.19.0 | 20.x LTS |
| RAM | 4 GB | 8 GB+ |
| Freier Speicher | 50 GB | 500 GB+ |

Node-Version prüfen:

```bash
node --version
```

## 2) Externe Tools

Ripster benötigt folgende CLI-Tools im `PATH`:

- `makemkvcon`
- `HandBrakeCLI`
- `mediainfo`

Schnell prüfen:

```bash
makemkvcon --version
HandBrakeCLI --version
mediainfo --Version
```

## 3) Optisches Laufwerk

Für Disc-Betrieb muss ein DVD/Blu-ray-Laufwerk erreichbar sein.

```bash
ls /dev/sr*
lsblk | grep rom
```

Wenn nötig Rechte setzen (Beispiel):

```bash
sudo chmod a+rw /dev/sr0
```

## 4) OMDb API-Key

Für automatische Metadaten (Titel, Poster, IMDb-ID):

1. Key unter [omdbapi.com](https://www.omdbapi.com/apikey.aspx) anlegen
2. in den `Settings` als `omdb_api_key` eintragen

## 5) Optional: PushOver

Für Push-Nachrichten bei Erfolg/Fehler:

- Account/App auf [pushover.net](https://pushover.net)
- `pushover_token` und `pushover_user` später in den `Settings` setzen

## Abschluss-Checkliste

- [ ] Node.js 20.x verfügbar
- [ ] `makemkvcon`, `HandBrakeCLI`, `mediainfo` ausführbar
- [ ] Laufwerk erkannt
- [ ] OMDb Key bereit
