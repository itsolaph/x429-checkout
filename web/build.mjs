// Builds the dashboard into site/: bundles web/src/main.ts and copies the static files.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "web/src/main.ts")],
  outfile: join(out, "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});
for (const f of ["index.html", "style.css"]) copyFileSync(join(root, "web", f), join(out, f));
console.log("built site/ (index.html, style.css, app.js)");
