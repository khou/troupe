#!/usr/bin/env node
import('../dist/cli/index.js').then(({ main }) =>
  main(process.argv.slice(2)).catch((err) => {
    console.error(`trupe: ${err?.message ?? err}`);
    process.exit(1);
  }),
);
