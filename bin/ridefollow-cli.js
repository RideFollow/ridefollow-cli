#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((err) => {
  // Restore the terminal in case the UI was mid-render, then report cleanly.
  try {
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\x1b[?1049l');
  } catch {
    /* ignore */
  }
  process.stderr.write(`\nridefollow-cli: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
