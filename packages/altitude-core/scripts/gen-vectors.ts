import { writeFileSync } from 'node:fs';
import { buildVectorsJson, VECTORS_PATH } from './vectors';

writeFileSync(VECTORS_PATH, buildVectorsJson());
console.log(`wrote ${VECTORS_PATH}`);
