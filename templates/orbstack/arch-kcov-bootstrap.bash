#!/usr/bin/env bash
# Template only. Run inside an OrbStack Arch machine as the default Linux user:
#
#   orb create arch:current zig-qm-arch
#   orb -m zig-qm-arch bash /path/to/templates/orbstack/arch-kcov-bootstrap.bash
#
# Arch Linux ARM publishes kcov in the regular package repository; this keeps
# the local coverage lane package-based instead of requiring a source build.
set -euo pipefail

sudo pacman -Sy --noconfirm --needed git curl ca-certificates unzip kcov

if ! command -v mise >/dev/null 2>&1; then
	curl https://mise.run | sh
fi

if ! command -v bun >/dev/null 2>&1; then
	curl -fsSL https://bun.sh/install | bash
fi

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mise use -g zig@0.16.0

mise x zig@0.16.0 -- zig version
bun --version
kcov --version
