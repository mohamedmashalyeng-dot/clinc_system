import { openDb, scalar } from './db/db.js';
import { createApp } from './app.js';
import { seedDemo } from './db/seed.js';
import { DEMO_MODE } from './settings.js';

openDb();
if (!scalar<number>('SELECT COUNT(*) FROM users')) {
  if (!DEMO_MODE) {
    console.error('Database is empty and demo mode is off. Create the first owner account before starting (see README).');
    process.exit(1);
  }
  console.log('[luma] Empty database — loading fictional demo data…');
  seedDemo();
}

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`[luma] API listening on http://localhost:${port}${DEMO_MODE ? ' (DEMO MODE — fictional data)' : ''}`);
});
