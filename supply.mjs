#!/usr/bin/env node
/** Точка входу. Уся логіка — у src/cli.mjs. */
import { main } from "./src/cli.mjs";

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`  ${e.message}`);
  process.exitCode = 1;
}
