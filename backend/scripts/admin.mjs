// Yukti platform admin accounts (staff only). No prompts, so it works in scripts and CI:
//   npm run admin:create -- <email> [--password <pw>] [--name <name>]
//       Creates a staff user (a random password is generated and printed once unless --password is
//       given) or promotes an existing user. An existing user's password changes only with --password.
//   npm run admin:revoke -- <email>
//       Removes the staff flag; the account itself is kept.
import { parseArgs } from 'node:util';
import { createStore } from '../src/data/store.js';
import { grantPlatformAdmin, revokePlatformAdmin } from '../src/services/platform-accounts.js';

const USAGE = `Usage:
  npm run admin:create -- <email> [--password <pw>] [--name <name>]
  npm run admin:revoke -- <email>`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      password: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}
const [command, email] = parsed.positionals;
if (parsed.values.help || !['create', 'revoke'].includes(command) || !email) {
  console.error(USAGE);
  process.exit(parsed.values.help ? 0 : 2);
}

const store = await createStore();
try {
  if (command === 'create') {
    const { user, created, password } = await grantPlatformAdmin(store, {
      email,
      password: parsed.values.password,
      name: parsed.values.name,
    });
    console.log(`${created ? 'Created' : 'Promoted'} platform admin ${user.email}.`);
    if (password)
      console.log(`Password (shown once, store it now): ${password}\nSign in, then open /admin.`);
    else console.log('Sign in, then open /admin.');
  } else {
    const { user, changed } = await revokePlatformAdmin(store, email);
    console.log(
      changed
        ? `${user.email} is no longer a platform admin.`
        : `${user.email} was not a platform admin.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await store.close();
}
