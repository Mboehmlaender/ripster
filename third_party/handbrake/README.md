# Bundled HandBrakeCLI

Ripster includes `bin/HandBrakeCLI` as a separately executable third-party
component. Ripster starts this binary as an external process; the HandBrake
source code is not part of the original Ripster source code.

HandBrakeCLI is developed by the HandBrake project and is distributed under the
GNU General Public License version 2 (`GPL-2.0-only`). Ripster's
`GPL-2.0-or-later` license does not replace or modify the HandBrake license.

The files in this directory document the bundled binary:

- `COPYING`: GPL version 2 license text for HandBrakeCLI.
- `BUILDINFO.md`: currently known build information and unresolved TODOs.
- `SHA256SUMS`: checksum for the bundled binary and TODOs for source archive checksums.
- `DYNAMIC-LIBRARIES.txt`: `ldd` output for the bundled binary.
- `HARDWARE-ENCODERS.txt`: local inspection notes for hardware and FDK-AAC related strings.
- `build-handbrake.sh`: reproducibility scaffold for rebuilding the binary.
- `patches/`: patch publication area.
- `source/`: corresponding source publication notes.

The complete corresponding source code for the bundled `bin/HandBrakeCLI`
binary must be made available together with the corresponding Ripster release.
Unknown values are intentionally marked as `TODO`; they must be resolved before
publishing a release that redistributes this binary.
