#!/usr/bin/env bash

set -euo pipefail

echo "========================================"
echo " Official VS Code installer for Ubuntu"
echo "========================================"

BACKUP_DIR="$HOME/vscode-backup-$(date +%Y%m%d-%H%M%S)"

echo
echo "[1/8] Closing VS Code..."
pkill -f "/snap/code" 2>/dev/null || true
pkill -f "code" 2>/dev/null || true
sleep 2

echo
echo "[2/8] Backing up VS Code configuration..."
mkdir -p "$BACKUP_DIR"

if [ -d "$HOME/.config/Code" ]; then
    cp -a "$HOME/.config/Code" "$BACKUP_DIR/Code-config"
    echo "Backed up ~/.config/Code"
fi

if [ -d "$HOME/.vscode" ]; then
    cp -a "$HOME/.vscode" "$BACKUP_DIR/vscode"
    echo "Backed up ~/.vscode"
fi

echo
echo "Backup location:"
echo "$BACKUP_DIR"

echo
echo "[3/8] Removing Snap VS Code..."

if snap list code >/dev/null 2>&1; then
    sudo snap remove code
else
    echo "Snap VS Code is not installed."
fi

echo
echo "[4/8] Installing required packages..."

sudo apt update
sudo apt install -y wget gpg apt-transport-https ca-certificates

echo
echo "[5/8] Installing Microsoft's signing key..."

sudo rm -f /usr/share/keyrings/microsoft.gpg

wget -qO- https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor \
    | sudo tee /usr/share/keyrings/microsoft.gpg >/dev/null

sudo chmod 644 /usr/share/keyrings/microsoft.gpg

echo
echo "[6/8] Adding official Microsoft VS Code repository..."

sudo tee /etc/apt/sources.list.d/vscode.sources >/dev/null <<'EOF'
Types: deb
URIs: https://packages.microsoft.com/repos/code
Suites: stable
Components: main
Architectures: amd64 arm64 armhf
Signed-By: /usr/share/keyrings/microsoft.gpg
EOF

sudo apt update

echo
echo "[7/8] Installing official VS Code..."

sudo apt install -y code

echo
echo "[8/8] Configuring VS Code cursor/GPU workaround..."

ARGV_DIR="$HOME/.config/Code"
ARGV_FILE="$ARGV_DIR/argv.json"

mkdir -p "$ARGV_DIR"

python3 <<'PY'
import json
from pathlib import Path

path = Path.home() / ".config" / "Code" / "argv.json"

data = {}

if path.exists():
    try:
        text = path.read_text().strip()

        # Remove VS Code // comments before parsing.
        lines = [
            line for line in text.splitlines()
            if not line.lstrip().startswith("//")
        ]

        cleaned = "\n".join(lines).strip()

        if cleaned:
            data = json.loads(cleaned)

    except Exception:
        backup = path.with_suffix(".json.backup")
        backup.write_text(path.read_text())
        data = {}

data["disable-hardware-acceleration"] = True

path.write_text(json.dumps(data, indent=4) + "\n")

print(f"Updated: {path}")
PY

echo
echo "========================================"
echo " Installation verification"
echo "========================================"

echo
echo "VS Code executable:"
command -v code

echo
echo "VS Code version:"
code --version

echo
echo "APT package:"
dpkg -l | grep -E '^ii[[:space:]]+code[[:space:]]' || true

echo
echo "Snap check:"
if snap list code >/dev/null 2>&1; then
    echo "WARNING: Snap version still exists."
else
    echo "PASS: Snap VS Code removed."
fi

echo
echo "Expected executable: /usr/bin/code"

CODE_PATH="$(command -v code || true)"

if [ "$CODE_PATH" = "/usr/bin/code" ]; then
    echo "PASS: Official APT VS Code is active."
else
    echo "WARNING: Current code executable is: $CODE_PATH"
fi

echo
echo "Hardware acceleration setting:"
cat "$ARGV_FILE"

echo
echo "========================================"
echo " Installation complete"
echo "========================================"
echo
echo "Start VS Code with:"
echo "code"
echo
echo "Your backup is stored at:"
echo "$BACKUP_DIR"
