# Third-Party Notices

Ripster uses and orchestrates third-party software and services. These
components remain subject to their own licenses, copyright notices and terms of
use.

The Ripster license does not replace or modify the licenses of these
third-party components.

## Bundled HandBrakeCLI

Ripster includes a separately executable build of HandBrakeCLI to provide
hardware-accelerated video encoding on supported Linux systems.

HandBrakeCLI is an independent third-party program developed by the HandBrake
project. It is not part of the original Ripster source code and is not licensed
under Ripster's `GPL-2.0-or-later` license.

The bundled HandBrakeCLI executable is distributed under the GNU General Public
License version 2 (`GPL-2.0-only`).

The corresponding license text, build information, checksums, build scripts,
patches and corresponding source notes are provided under:

- `third_party/handbrake/COPYING`
- `third_party/handbrake/BUILDINFO.md`
- `third_party/handbrake/SHA256SUMS`
- `third_party/handbrake/build-handbrake.sh`
- `third_party/handbrake/patches/`
- `third_party/handbrake/source/`

The currently bundled binary contains FDK-AAC related strings. Redistribution
of this binary is marked as unresolved until a separate legal review is
completed or the binary is replaced by a clean rebuild without FDK-AAC.

Ripster is not affiliated with or endorsed by the HandBrake project.

## External media tools

Depending on the selected workflow and system configuration, Ripster can invoke
external tools including:

- MakeMKV
- FFmpeg and FFprobe
- MediaInfo
- MKVToolNix / `mkvmerge`
- cdparanoia
- FLAC
- LAME
- Opus Tools
- Vorbis Tools

These programs are not relicensed by Ripster. Users and distributors are
responsible for complying with their respective licenses and usage conditions.
MakeMKV is subject to its own license and registration terms.

## JavaScript dependencies

The frontend and backend use open-source packages distributed through the
Node.js ecosystem. Their respective licenses and copyright notices remain
applicable.

Dependency information can be found in the relevant `package.json` and lock
files.

## External metadata and notification services

Ripster may integrate with external services such as:

- TMDB
- MusicBrainz
- Audnexus
- Pushover

Use of these services is subject to their respective terms, API policies and
data licenses.

### TMDB notice

This product uses the TMDB API but is not endorsed or certified by TMDB.
