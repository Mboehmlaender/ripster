# Voraussetzungen

Bevor du Ripster installierst, stelle sicher, dass folgende Software auf deinem System verfügbar ist.

---

## System-Anforderungen

| Anforderung | Mindestversion | Empfohlen |
|------------|----------------|-----------|
| **Betriebssystem** | Linux / macOS | Ubuntu 22.04+ |
| **Node.js** | 20.19.0 | 20.x LTS |
| **RAM** | 4 GB | 8 GB+ |
| **Festplatte** | 50 GB frei | 500 GB+ (für Roh-MKVs) |

---

## Node.js

Ripster benötigt **Node.js >= 20.19.0**.

=== "nvm (empfohlen)"

    ```bash
    # nvm installieren
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    # Node.js 20 installieren
    nvm install 20
    nvm use 20

    # Version prüfen
    node --version  # v20.x.x
    ```

=== "Ubuntu/Debian"

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs

    node --version  # v20.x.x
    ```

=== "macOS (Homebrew)"

    ```bash
    brew install node@20
    node --version  # v20.x.x
    ```

---

## Externe Tools

### MakeMKV

!!! warning "Lizenz erforderlich"
    MakeMKV ist für den persönlichen Gebrauch kostenlos (Beta-Lizenz), benötigt aber eine gültige Lizenz.

```bash
# Ubuntu/Debian - PPA verwenden
sudo add-apt-repository ppa:heyarje/makemkv-beta
sudo apt-get update
sudo apt-get install makemkv-bin makemkv-oss

# Installierte Version prüfen
makemkvcon --version
```

[:octicons-link-external-24: MakeMKV Download](https://www.makemkv.com/download/){ .md-button }

### HandBrake CLI

```bash
# Ubuntu/Debian
sudo add-apt-repository ppa:stebbins/handbrake-releases
sudo apt-get update
sudo apt-get install handbrake-cli

# Version prüfen
HandBrakeCLI --version

# macOS
brew install handbrake
```

[:octicons-link-external-24: HandBrake Download](https://handbrake.fr/downloads2.php){ .md-button }

### MediaInfo

```bash
# Ubuntu/Debian
sudo apt-get install mediainfo

# macOS
brew install mediainfo

# Version prüfen
mediainfo --Version
```

---

## Disc-Laufwerk

Ripster benötigt ein physisches **DVD- oder Blu-ray-Laufwerk**.

!!! danger "LibDriveIO-Modus erforderlich"
    Das Laufwerk muss im **LibDriveIO-Modus** betrieben werden – MakeMKV greift direkt auf Rohdaten des Laufwerks zu. Ohne diesen Modus können verschlüsselte Blu-rays (insbesondere UHD) nicht gelesen werden.

    Nicht alle Laufwerke unterstützen den direkten Zugriff. Eine Anleitung zur Einrichtung und Liste kompatibler Laufwerke findet sich im [MakeMKV-Forum](https://www.makemkv.com/forum/viewtopic.php?t=18856).

```bash
# Laufwerk prüfen
ls /dev/sr*
# oder
lsblk | grep rom

# Laufwerk-Berechtigungen setzen (erforderlich für LibDriveIO)
sudo chmod a+rw /dev/sr0
```

!!! info "Blu-ray unter Linux"
    MakeMKV bringt mit LibDriveIO eine eigene Entschlüsselung mit – externe Bibliotheken wie `libaacs` sind in der Regel nicht erforderlich.

---

## OMDb API-Key

Ripster verwendet die [OMDb API](https://www.omdbapi.com/) für Filmmetadaten.

1. Registriere dich kostenlos auf [omdbapi.com](https://www.omdbapi.com/apikey.aspx)
2. Bestätige deine E-Mail-Adresse
3. Notiere deinen API-Key – du gibst ihn später in den Einstellungen ein

---

## Optionale Voraussetzungen

### PushOver (Benachrichtigungen)

Für mobile Push-Benachrichtigungen bei Fertigstellung oder Fehlern:

- App kaufen auf [pushover.net](https://pushover.net) (~5 USD einmalig)
- **User Key** und **API Token** notieren

---

## Checkliste

- [ ] Node.js >= 20.19.0 installiert (`node --version`)
- [ ] `makemkvcon` installiert (`makemkvcon --version`)
- [ ] `HandBrakeCLI` installiert (`HandBrakeCLI --version`)
- [ ] `mediainfo` installiert (`mediainfo --Version`)
- [ ] DVD/Blu-ray Laufwerk vorhanden (`ls /dev/sr*`)
- [ ] OMDb API-Key beschafft
