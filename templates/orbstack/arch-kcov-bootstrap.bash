#!/usr/bin/env bash
# Template only. Run inside an OrbStack Arch machine as the default Linux user:
#
#   orb create archlinux:base@sha256:068a765646e75e51fe5d544b0f95c85d0322d0a372659e9d5f10fb8402ca53f1 zig-qm-arch
#   orb -m zig-qm-arch bash /path/to/templates/orbstack/arch-kcov-bootstrap.bash
#
# Arch Linux ARM publishes kcov in the regular package repository; this keeps
# the local coverage lane package-based instead of requiring a source build.
set -euo pipefail

sudo pacman -Syu --noconfirm --needed git curl ca-certificates unzip kcov

command -v mise >/dev/null 2>&1 || {
	echo "install mise from a pinned package or checksum-verified artifact before running this template" >&2
	exit 1
}
command -v bun >/dev/null 2>&1 || {
	echo "install bun from a pinned package or checksum-verified artifact before running this template" >&2
	exit 1
}

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mise use -g zig@0.16.0

mise x zig@0.16.0 -- zig version
bun --version
kcov --version
