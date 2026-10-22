#!/usr/bin/env bash
#
# Bouwt beide extensies (Firefox MV2, Chrome MV3) vanuit één bron. Eén
# extensie, twee shop-backends, elk met een eigen content script:
#
#   src/tymes4/  → Tymes4-shops (NEC, FC Twente, Willem II, …)
#   src/tixx/    → Eventim TIXX-shops (1. FC Köln, BvB, …) + background
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
# bron (onder src/) → naam in de extensie; de voorvoegsels houden de twee
# backends uit elkaars vaarwater.
FILES=(
  "tymes4/content.js:tymes4-content.js"
  "tymes4/styles.css:tymes4.css"
  "tixx/core.js:tixx-core.js"
  "tixx/content.js:tixx-content.js"
  "tixx/background.js:tixx-background.js"
  "tixx/styles.css:tixx.css"
)
OUT=()
for pair in "${FILES[@]}"; do OUT+=("${pair#*:}"); done

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
for var in API_ORIGIN SHOP_ORIGIN TIXX_API_ORIGIN TIXX_SHOP_ORIGIN TIXX_SHOP_PATHS; do
  if [ -z "${!var:-}" ]; then
    echo "✗ $var ontbreekt."
    echo "  Zet API_ORIGIN/SHOP_ORIGIN (Tymes4) en TIXX_API_ORIGIN/TIXX_SHOP_ORIGIN/"
    echo "  TIXX_SHOP_PATHS in .env (zie .env.example), of in de omgeving — in CI als repo-secret."
    exit 1
  fi
done

# Tymes4 — meerdere clubs in één build: beide variabelen mogen een door spaties
# gescheiden lijst zijn, gekoppeld op volgorde (n-de shop ↔ n-de API).
read -r -a SHOPS <<< "$SHOP_ORIGIN"
read -r -a APIS <<< "$API_ORIGIN"
if [ "${#SHOPS[@]}" -ne "${#APIS[@]}" ]; then
  echo "✗ SHOP_ORIGIN heeft ${#SHOPS[@]} waarde(n), API_ORIGIN ${#APIS[@]} — die horen paarsgewijs gelijk op te lopen."
  exit 1
fi
SITES_JSON="{"
SHOP_GLOBS=""
API_GLOBS=""
for i in "${!SHOPS[@]}"; do
  shop="${SHOPS[$i]%/}"; api="${APIS[$i]%/}"
  [ "$i" -gt 0 ] && { SITES_JSON+=", "; SHOP_GLOBS+='", "'; API_GLOBS+='", "'; }
  SITES_JSON+="\"$shop\": \"$api\""
  SHOP_GLOBS+="$shop/*"
  API_GLOBS+="$api/*"
done
SITES_JSON+="}"

# TIXX — optioneel: verkoopdata-pagina's per club ("club=url club=url"). Elke
# origin krijgt een eigen permission-regel; zonder TIXX_SCHEDULES valt de
# placeholderregel weg.
TIXX_SCHEDULES="${TIXX_SCHEDULES:-}"
SCHEDULE_PERMS=""
for pair in $TIXX_SCHEDULES; do
  origin="$(printf '%s' "${pair#*=}" | sed -E 's|^(https?://[^/]+).*|\1|')"
  SCHEDULE_PERMS="$SCHEDULE_PERMS    \"$origin/*\",\n"
done
# '&' betekent in een sed-vervanging "de match"; letterlijk houden.
SCHEDULES_SED="${TIXX_SCHEDULES//&/\\&}"

# In de manifests staat elke Tymes4-placeholder als één array-element
# ("__X__/*"); dat wordt hier uitgeschreven tot één element per club.
subst() {  # subst <bron> <doel>
  sed -e "s|__API_ORIGIN__/\*|$API_GLOBS|g" \
      -e "s|__SHOP_ORIGIN__/\*|$SHOP_GLOBS|g" \
      -e "s|__SITES__|$SITES_JSON|g" \
      -e "s|__TIXX_API_ORIGIN__|$TIXX_API_ORIGIN|g" \
      -e "s|__TIXX_SHOP_ORIGIN__|$TIXX_SHOP_ORIGIN|g" \
      -e "s|__TIXX_SHOP_PATHS__|$TIXX_SHOP_PATHS|g" \
      -e "s|__TIXX_SCHEDULES__|$SCHEDULES_SED|g" "$1" > "$2"
}

echo "▶ Bron syncen vanuit src/ ..."
for dir in "$FF" "$CH"; do
  for pair in "${FILES[@]}"; do
    subst "$SRC/${pair%%:*}" "$dir/${pair#*:}"
  done
  subst "$dir/manifest.template.json" "$dir/manifest.json.tmp"
  awk -v perms="$SCHEDULE_PERMS" '/"__TIXX_SCHEDULE_PERMS__",/ { printf "%s", perms; next } { print }' \
    "$dir/manifest.json.tmp" > "$dir/manifest.json"
  rm -f "$dir/manifest.json.tmp"
done

# Vangnet: een onvervangen placeholder levert een pakket op dat er wél normaal
# uitziet maar nergens verbinding mee maakt. Alleen de GEGENEREERDE bestanden
# controleren — de templates horen juist placeholders te bevatten.
GENERATED=()
for dir in "$FF" "$CH"; do
  for f in "${OUT[@]}" manifest.json; do GENERATED+=("$dir/$f"); done
done
if grep -n '__[A-Z][A-Z_]*__' "${GENERATED[@]}"; then
  echo "✗ Onvervangen placeholder in de build (zie hierboven)."
  exit 1
fi

echo "▶ Syntax- en manifestcontrole ..."
for f in "$FF"/*.js; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('$FF/manifest.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('$CH/manifest.json','utf8'))"

echo "▶ Firefox .xpi inpakken ..."
rm -f "$DIST/seat-assist-firefox.xpi"
( cd "$FF" && zip -j -X "$DIST/seat-assist-firefox.xpi" manifest.json "${OUT[@]}" >/dev/null )

echo "▶ Chrome .zip inpakken ..."
rm -f "$DIST/seat-assist-chrome.zip"
( cd "$CH" && zip -j -X "$DIST/seat-assist-chrome.zip" manifest.json "${OUT[@]}" >/dev/null )

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
