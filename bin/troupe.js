#!/usr/bin/env node
import('../dist/cli/index.js').then(({ main }) =>
  main(process.argv.slice(2)).catch((err) => {
    console.error(`troupe: ${err?.message ?? err}`);
    process.exit(1);
  }),
);
