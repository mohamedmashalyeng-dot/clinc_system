// `npm run seed` — wipe the local database and uploads, then load fresh fictional demo data.
import { resetDemoData } from './seed.js';

resetDemoData();
console.log('[luma] Demo data reset complete.');
