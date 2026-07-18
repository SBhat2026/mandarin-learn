#!/usr/bin/env bash
# Download open-licensed Mandarin datasets into ingest/sources/, then package the
# vocab + sentence decks into .apkg files and a frequency CSV.
#
#   bash ingest/tools/fetch-open-data.sh
#
# Sources & licenses:
#   CC-CEDICT           CC BY-SA 4.0   (MDBG)
#   complete-hsk-vocab  MIT            (github.com/drkameleon/complete-hsk-vocabulary)
#   Tatoeba cmn-eng     CC BY 2.0 FR   (tatoeba.org via manythings.org)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/ingest/sources"
mkdir -p "$SRC"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

echo "→ CC-CEDICT"
curl -fsSL -o "$SRC/cedict.txt.gz" "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz"
gunzip -f "$SRC/cedict.txt.gz"
mv -f "$SRC/cedict.txt" "$SRC/cedict_ts.u8"

echo "→ HSK 1-7 vocabulary (complete-hsk-vocabulary, MIT)"
curl -fsSL -o "$SRC/hsk.json" "https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json"

echo "→ Tatoeba cmn-eng sentence pairs (CC BY 2.0)"
curl -fsSL -o "$SRC/cmn-eng.zip" "https://www.manythings.org/anki/cmn-eng.zip" \
  -H "User-Agent: $UA" -H "Accept: text/html,*/*;q=0.8" -e "https://www.manythings.org/anki/"
( cd "$SRC" && unzip -o cmn-eng.zip >/dev/null && rm -f cmn-eng.zip _about.txt 2>/dev/null || true )

echo "→ Packaging decks + frequency CSV"
node "$ROOT/ingest/tools/build-open-decks.js"

echo "Done. Next: npm run ingest:all"
