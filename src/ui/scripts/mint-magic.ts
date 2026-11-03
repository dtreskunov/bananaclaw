/**
 * mint-magic — issue a UI magic-link login URL for a user.
 *
 * Usage:
 *   pnpm exec tsx src/ui/scripts/mint-magic.ts <user-id>
 *   pnpm exec tsx src/ui/scripts/mint-magic.ts --list      # print users
 *   pnpm exec tsx src/ui/scripts/mint-magic.ts --help
 *
 * Base URL comes from UI_BASE_URL in .env (via `uiBaseUrl()`); there is no
 * CLI override. Imports the same APIs the running host uses so the result
 * matches what /ui would produce.
 */
import path from 'path';

import { initDb } from '../../db/connection.js';
import { getAllUsers } from '../../modules/permissions/db/users.js';
import { issueMagicLink } from '../server/auth.js';
import { uiBaseUrl } from '../server/config.js';

const HELP = `mint-magic — issue a UI magic-link login URL.

Usage:
  mint-magic <user-id>      mint a login URL for the given user
  mint-magic --list         print id\tdisplay_name\tkind for every user
  mint-magic -h | --help    show this help

Base URL is read from UI_BASE_URL in .env.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  initDb(path.resolve(process.cwd(), 'data', 'v2.db'));

  if (args.includes('--list') || args.includes('-l')) {
    const users = getAllUsers();
    for (const u of users) {
      process.stdout.write(`${u.id}\t${u.display_name ?? ''}\t${u.kind}\n`);
    }
    return;
  }

  const userId = args[0];
  if (!userId) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  const { token } = issueMagicLink(userId);
  console.log(`${uiBaseUrl()}/auth/redeem?t=${token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
