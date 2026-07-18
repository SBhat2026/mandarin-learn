import { rmSync } from 'node:fs';
import { DB_PATH } from '../server/db.js';
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(DB_PATH + suffix, { force: true });
}
console.log('Removed', DB_PATH, '(+ WAL/SHM). Run npm run db:init to recreate.');
