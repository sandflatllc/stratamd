#!/bin/sh
# Installs StrataMD from source on Linux. Safe to run again: it reuses the
# checkout, rebuilds, and re-runs setup, which only rewrites what changed.
#
# Environment:
#   STRATAMD_CHECKOUT  where to clone (default ~/.local/src/stratamd);
#                      ignored when this script runs from inside a checkout
#   STRATAMD_REPO      git URL to clone from
#   STRATAMD_SKILL     where setup copies the agent skill: claude (default),
#                      codex, agents, or a skills directory
set -eu

REPO_URL=${STRATAMD_REPO:-https://github.com/sandflatllc/stratamd.git}
CHECKOUT=${STRATAMD_CHECKOUT:-$HOME/.local/src/stratamd}
SKILL=${STRATAMD_SKILL:-claude}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
managed_checkout=1
if [ -n "$script_dir" ] && [ -f "$script_dir/../package.json" ] \
  && grep -q '"name": "stratamd"' "$script_dir/../package.json"; then
  CHECKOUT=$(CDPATH= cd -- "$script_dir/.." && pwd)
  managed_checkout=0
fi

# Prerequisites. Column order: command, apt package, dnf package, pacman package.
missing_tools=''
missing_apt=''
missing_dnf=''
missing_pacman=''
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  missing_tools="$missing_tools $1"
  missing_apt="$missing_apt $2"
  missing_dnf="$missing_dnf $3"
  missing_pacman="$missing_pacman $4"
}
need git git git git
need node nodejs nodejs nodejs
need python3 python3 python3 python
need make make make make
need g++ g++ gcc-c++ gcc
need update-desktop-database desktop-file-utils desktop-file-utils desktop-file-utils
need update-mime-database shared-mime-info shared-mime-info shared-mime-info

if [ -n "$missing_tools" ]; then
  echo "StrataMD needs these commands and they are not installed:$missing_tools" >&2
  echo "Install them, then run this script again:" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "  sudo apt-get install -y$missing_apt" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install -y$missing_dnf" >&2
  elif command -v pacman >/dev/null 2>&1; then
    echo "  sudo pacman -S --needed$missing_pacman" >&2
  else
    echo "  apt:    sudo apt-get install -y$missing_apt" >&2
    echo "  dnf:    sudo dnf install -y$missing_dnf" >&2
    echo "  pacman: sudo pacman -S --needed$missing_pacman" >&2
  fi
  echo "Node.js must be 22 or newer; if your distribution ships an older one, install it from https://nodejs.org." >&2
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "StrataMD needs Node.js 22 or newer; found $(node --version). Install a newer Node.js from https://nodejs.org and run this script again." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "StrataMD needs pnpm. Install it with one of these, then run this script again:" >&2
  echo "  corepack enable pnpm" >&2
  echo "  npm install -g pnpm" >&2
  exit 1
fi

if [ ! -d "$CHECKOUT/.git" ]; then
  echo "Cloning StrataMD into $CHECKOUT"
  mkdir -p "$(dirname -- "$CHECKOUT")"
  git clone "$REPO_URL" "$CHECKOUT"
elif [ "$managed_checkout" = 1 ]; then
  echo "Updating the checkout in $CHECKOUT"
  git -C "$CHECKOUT" pull --ff-only
else
  echo "Using the checkout in $CHECKOUT"
fi

cd "$CHECKOUT"
pnpm install --frozen-lockfile
# pnpm's build-script approval does not reliably run electron's install
# script, which downloads the binary; run it so dist/ exists before the build.
node node_modules/electron/install.js
pnpm build:linux

echo
echo "Registering the stratamd command, desktop entry, and the $SKILL skill"
./dist/linux-unpacked/stratamd setup --skill "$SKILL"

cat <<NEXT

StrataMD is installed at $CHECKOUT/dist/linux-unpacked.

Next steps:
  - If StrataMD is already running, quit it and open it again so it runs this build.
    stratamd --version shows whether the command and the running app agree.
  - Open a document:   stratamd open README.md
  - Ask your agent:    "Attach to the document I have open in Strata."
  - Any warning above about PATH or a missing package tells you what to add.

To update later, run this script again. To remove the command and desktop
entry, run: stratamd setup --remove
NEXT
