import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { cutoverStores, type StorePath } from '../src/db/offline-cutover.js';

const { values } = parseArgs({
  options: {
    plan: { type: 'string' },
    'backup-dir': { type: 'string' },
    'service-stopped': { type: 'boolean' },
    'runners-stopped': { type: 'boolean' },
  },
});
if (!values.plan || !values['backup-dir'])
  throw new Error('--plan and --backup-dir are required; see docs/db-storage-cutover.md');
await cutoverStores(JSON.parse(fs.readFileSync(values.plan, 'utf8')) as StorePath[], values['backup-dir'], {
  serviceStopped: values['service-stopped'] === true,
  runnersStopped: values['runners-stopped'] === true,
});
console.log(`Verified and cut over explicit store inventory. Backups: ${values['backup-dir']}`);
