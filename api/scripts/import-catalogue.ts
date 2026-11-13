/**
 * CLI: load the Oman places catalogue (malls.csv + stores.csv) into a running Locus API.
 *
 *   LOCUS_API_URL=https://locus-api.<you>.workers.dev LOCUS_PLATFORM_KEY=… \
 *     npm run import-catalogue --workspace api -- path/to/malls.csv path/to/stores.csv
 */
import { importCatalogue } from './catalogue';

const [mallsPath, storesPath] = process.argv.slice(2).filter((a) => a !== '--');
const api = process.env.LOCUS_API_URL;
const key = process.env.LOCUS_PLATFORM_KEY;
if (!mallsPath || !storesPath || !api || !key) {
  console.error('Usage: LOCUS_API_URL=… LOCUS_PLATFORM_KEY=… npm run import-catalogue --workspace api -- malls.csv stores.csv');
  process.exit(1);
}
const r = await importCatalogue(api, key, mallsPath, storesPath);
console.log(`Imported ${r.malls} malls and ${r.stores} stores.`);
