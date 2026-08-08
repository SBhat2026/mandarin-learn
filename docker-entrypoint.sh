#!/bin/sh
# First-boot seeding. The volume starts empty; content is copied from the image
# exactly once. Progress (app.db after first boot, users/, spend.json) then lives
# only on the volume, so later deploys never overwrite it.
set -e

mkdir -p /data /data/media /data/users

if [ ! -f /data/app.db ]; then
  echo "→ seeding content database onto the volume (first boot)…"
  cp /seed/app.db /data/app.db
else
  echo "→ existing database found on volume — preserving learner progress."
fi

# Media is additive: copy any files the image has that the volume lacks. This
# ships newly-imported audio on redeploy without clobbering the TTS cache.
if [ -d /seed/media ]; then
  cp -rn /seed/media/. /data/media/ 2>/dev/null || true
fi

exec "$@"
