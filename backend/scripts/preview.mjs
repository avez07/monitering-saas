// A single process for browser-test startup/teardown on Windows and Linux.
import '../src/server.js';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../frontend', import.meta.url));
const web = await createServer({ root, configFile: `${root}/vite.config.js` });
await web.listen();
web.printUrls();
