# HandBrakeCLI Build Information

> [!WARNING]
> The current binary contains FDK-AAC related strings (`libfdk_aac`, `HE-AAC (FDK)`).
> Redistribution of this build is unresolved and requires a separate legal review.
> A clean rebuild without FDK-AAC is recommended before publishing a redistributed binary.

## Binary

- Binary path: `bin/HandBrakeCLI`
- Binary architecture: ELF 64-bit LSB PIE executable, x86-64, dynamically linked
- Binary SHA-256: `19b3ad4cbfdc5fb295a966a4342fc11b3e6ef26a7b54f9aa751e9c9a7c00ecfb`
- Build date: TODO
- Build host operating system: TODO
- Compiler: TODO
- ELF BuildID: `d55936da5783a6957878fd1c27bfee75ea217c1b`

## HandBrake source

- HandBrake version reported by CLI: `1.10.0`
- Upstream repository: https://github.com/HandBrake/HandBrake
- Upstream tag: TODO
- Upstream commit: TODO

## Build configuration

```shell
TODO: Insert the exact configure and build commands used for this binary.
```

## Hardware acceleration

Local inspection found the following evidence:

- `HandBrakeCLI --help` mentions NVDec and QSV hardware decoding.
- Binary strings contain NVENC, NVDEC, QSV, AMD VCE/VCN, VAAPI and VideoToolbox related strings.
- Runtime availability depends on host hardware, drivers and libraries.

See `HARDWARE-ENCODERS.txt` for the captured inspection output.

## Source modifications

TODO: Confirm whether the bundled binary was built from unmodified HandBrake
source or with local patches. Do not publish a release with this binary until
this is resolved.

## Included patches

TODO: No patch files are currently provided in `patches/`. If the binary was
built with source modifications, publish each modification as an ordered patch
file in that directory.

## Corresponding source

The complete corresponding source code for this binary is currently unresolved.

- TODO: Provide the source archive directly under `third_party/handbrake/source/`
  or publish it as an exact GitHub release asset associated with the matching
  Ripster release.
- TODO: Document the source archive SHA-256.
- TODO: Document the exact upstream tag or commit and all build inputs.

## Build dependencies

Known from local dynamic library inspection:

- Runtime dynamic libraries are listed in `DYNAMIC-LIBRARIES.txt`.

TODO: List the relevant build dependencies and versions used to produce this binary.

## Notes

This HandBrakeCLI build is distributed as an independent third-party component
under the GNU General Public License version 2 (`GPL-2.0-only`). Ripster starts
it as an external process.
