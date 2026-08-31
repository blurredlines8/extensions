#!/usr/bin/env bash
#
# Bouwt beide extensies vanuit één bron.
#
#   src/content.js  + src/styles.css   → de enige bron voor de gedeelde code
#   firefox-extension/ , chrome-extension/  → eigen manifest.json + gekopieerde bron
#   dist/  → inpakbare pakketten (.xpi voor Firefox, .zip voor Chrome)
#
# Gebruik:
#   ./build.sh                 # sync + syntaxcheck + inpakken (raakt AMO niet)
#   ./build.sh sign            # + laten signen via AMO (keys uit .env of omgeving)
#
set -euo pipefail

SIGN=0
if [ "${1:-}" = "sign" ] || [ "${1:-}" = "--sign" ]; then SIGN=1; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"
FF="$ROOT/firefox-extension"
CH="$ROOT/chrome-extension"
DIST="$ROOT/dist"
SHARED=(content.js styles.css)

# Laad instellingen/credentials uit .env als dat bestaat (bijv. AMO-keys voor
# web-ext sign). .env staat in .gitignore en wordt niet gedeeld.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ROOT/.env"
  set +a
fi

mkdir -p "$DIST"

# De shop-URL's staan niet in de repo maar in .env, en worden hier in de bron
# gesubstitueerd. Zonder die waarden zou er een pakket met letterlijke
# placeholders ontstaan; dan liever meteen stoppen.
for var in API_ORIGIN SHOP_ORIGIN; do
  if [ -z "${!var:-}" ]; then
    echo "✗ $var ontbreekt."
    echo "  Zet API_ORIGIN en SHOP_ORIGIN in .env (zie .env.example),"
    echo "  of in de omgeving — in CI als repo-secret."
    exit 1
  fi
done

subst() {  # subst <bron> <doel>
  sed -e "s|__API_ORIGIN__|$API_ORIGIN|g" \
      -e "s|__SHOP_ORIGIN__|$SHOP_ORIGIN|g" "$1" > "$2"
}

echo "▶ Gedeelde bestanden syncen vanuit src/ ..."
for dir in "$FF" "$CH"; do
  for f in "${SHARED[@]}"; do
    subst "$SRC/$f" "$dir/$f"
  done
  subst "$dir/manifest.template.json" "$dir/manifest.json"
done

# Vangnet: een onvervangen placeholder levert een pakket op dat er wél normaal
# uitziet maar nergens verbinding mee maakt. Alleen de GEGENEREERDE bestanden
# controleren — de templates horen juist placeholders te bevatten.
GENERATED=()
for dir in "$FF" "$CH"; do
  for f in "${SHARED[@]}" manifest.json; do GENERATED+=("$dir/$f"); done
done
if grep -n '__[A-Z][A-Z_]*__' "${GENERATED[@]}"; then
  echo "✗ Onvervangen placeholder in de build (zie hierboven)."
  exit 1
fi

echo "▶ Syntax- en manifestcontrole ..."
node --check "$SRC/content.js"
node -e "JSON.parse(require('fs').readFileSync('$FF/manifest.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$CH/manifest.json','utf8'))"

echo "▶ Firefox .xpi inpakken ..."
rm -f "$DIST/seat-assist-firefox.xpi"
( cd "$FF" && zip -j -X "$DIST/seat-assist-firefox.xpi" manifest.json "${SHARED[@]}" >/dev/null )

echo "▶ Chrome .zip inpakken ..."
rm -f "$DIST/seat-assist-chrome.zip"
( cd "$CH" && zip -j -X "$DIST/seat-assist-chrome.zip" manifest.json "${SHARED[@]}" >/dev/null )

echo "✓ Pakketten:"
ls -1 "$DIST"

# Signen gebeurt ALLEEN op expliciet verzoek (./build.sh sign), nooit vanzelf —
# ook niet als er toevallig AMO-keys in de omgeving staan.
if [ "$SIGN" -ne 1 ]; then
  echo "ℹ Alleen ingepakt. Draai './build.sh sign' om ook via AMO te laten signen."
  exit 0
fi

if [ -z "${WEB_EXT_API_KEY:-}" ] || [ -z "${WEB_EXT_API_SECRET:-}" ]; then
  echo "✗ Signen gevraagd, maar WEB_EXT_API_KEY/WEB_EXT_API_SECRET ontbreken."
  echo "  Zet ze in .env (kopieer .env.example) of in je omgeving."
  exit 1
fi

WEB_EXT="$ROOT/node_modules/.bin/web-ext"
if [ ! -x "$WEB_EXT" ]; then
  echo "✗ web-ext niet gevonden op $WEB_EXT. Installeer met: npm install web-ext"
  exit 1
fi

VERSION="$(node -e "process.stdout.write(String(require('$FF/manifest.json').version))")"
ID="$(node -e "process.stdout.write(String(require('$FF/manifest.json').browser_specific_settings.gecko.id))")"
GH_REPO="${GH_REPO:-OWNER/REPO}"

if grep -q 'OWNER/REPO' "$FF/manifest.json"; then
  echo "⚠ manifest.json bevat nog 'OWNER/REPO' in update_url — auto-update werkt pas"
  echo "  als je dat naar je echte GitHub-repo zet (vóór het signen!)."
fi

echo "▶ Firefox signen via AMO (unlisted), versie $VERSION ..."
echo "  Let op: AMO weigert een versie die al is ingediend — hoog anders eerst 'version' op."
mkdir -p "$DIST/signed"
"$WEB_EXT" sign --source-dir "$FF" --artifacts-dir "$DIST/signed" --channel=unlisted

# Geef het gesigneerde bestand een voorspelbare, geversioneerde naam en genereer
# de update-manifest die Firefox uitleest.
SIGNED="$(ls -t "$DIST/signed/"*.xpi 2>/dev/null | grep -v -- "-firefox-[0-9]" | head -1 || true)"
XPI_NAME="seat-assist-firefox-$VERSION.xpi"
if [ -n "$SIGNED" ]; then
  cp "$SIGNED" "$DIST/signed/$XPI_NAME"
fi

cat > "$ROOT/updates.json" <<EOF
{
  "addons": {
    "$ID": {
      "updates": [
        { "version": "$VERSION", "update_link": "https://github.com/$GH_REPO/releases/download/v$VERSION/$XPI_NAME" }
      ]
    }
  }
}
EOF

echo "✓ Gesigneerd: dist/signed/$XPI_NAME"
echo "✓ updates.json bijgewerkt (versie $VERSION, repo $GH_REPO)."
echo ""
echo "Nog te doen om te publiceren:"
echo "  1. Maak op GitHub een release met tag 'v$VERSION' en upload dist/signed/$XPI_NAME als asset."
echo "  2. Commit & push updates.json (die wordt via de raw-URL uitgelezen)."
