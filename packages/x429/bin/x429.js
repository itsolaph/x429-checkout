#!/usr/bin/env node
// npx x429: deploy your X429Checkout, open a queue, read its status, write an env template.
import { main } from "../dist/cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  cwd: process.cwd(),
});
