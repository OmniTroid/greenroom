import { $ } from "bun";

// Builds the client into ./dist as a static site for GitHub Pages. Bun bundles
// index.html with relative asset paths, so it works under a project sub-path
// (https://<user>.github.io/<repo>/). The `?folder=` local-server route and the
// ./assets host don't exist on Pages; load characters via `?url=` or the
// "Open folder…" picker, both of which are client-side.
const OUT = "dist";

await $`rm -rf ${OUT}`;
await $`bun build ./index.html --outdir ${OUT} --minify`;

// Without this, GitHub Pages runs the files through Jekyll.
await Bun.write(`${OUT}/.nojekyll`, "");

console.log(`\nBuilt static site to ./${OUT}/`);
