import { createPermSetDeps, permSet } from './perm-set.js';

process.exit(await permSet(process.argv.slice(2), createPermSetDeps()));
