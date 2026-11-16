#!/bin/sh
# Installerar hela kedjan: CLI:t `annotate` och Claude-skillen. Chrome-tillägget laddas manuellt (se slutet).
# Går att köra igen, t.ex. efter git pull.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)

# node:sqlite utan flagga kräver Node 22.13+
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) { console.error("annotate kräver Node 22.13 eller senare (du har " + process.versions.node + ")"); process.exit(1); }
'

echo "→ Installerar CLI:t (npm link)"
(cd "$ROOT" && npm link --silent)

echo "→ Länkar Claude-skillen till ~/.claude/skills/annotate"
mkdir -p "$HOME/.claude/skills"
TARGET="$HOME/.claude/skills/annotate"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
  echo "  Fanns redan en skill där, flyttad till $BACKUP"
  mv "$TARGET" "$BACKUP"
fi
ln -sfn "$ROOT/skills/annotate" "$TARGET"

# Startar om servern om den kör, så att den använder den nya koden.
if annotate status 2>/dev/null | grep -q "kör"; then
  echo "→ Startar om annotate-servern"
  annotate stop >/dev/null && annotate start >/dev/null
fi

cat <<EOF

Klart. Sista steget (en gång), i Chrome:
  1. Öppna chrome://extensions
  2. Slå på "Developer mode" (uppe till höger)
  3. "Load unpacked" → välj $ROOT/extension

Efter en uppdatering (git pull): kör ./install.sh igen och tryck ↻ på tillägget i chrome://extensions.

Använd: i valfritt repo med appen igång, säg "starta annoteringsläget" till Claude.
EOF
