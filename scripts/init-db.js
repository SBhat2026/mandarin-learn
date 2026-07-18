import { initSchema, DB_PATH } from '../server/db.js';
initSchema();
console.log('Schema initialized at', DB_PATH);
