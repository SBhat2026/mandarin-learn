import yauzl from 'yauzl';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Extract every entry of a zip into destDir. Returns list of relative names.
export function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const names = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
        const outPath = join(destDir, entry.fileName);
        mkdirSync(dirname(outPath), { recursive: true });
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const ws = createWriteStream(outPath);
          stream.pipe(ws);
          ws.on('finish', () => { names.push(entry.fileName); zip.readEntry(); });
          ws.on('error', reject);
        });
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
    });
  });
}
