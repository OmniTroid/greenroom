import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import index from "./index.html";

const PORT = Number(process.env.PORT ?? 3000);

// Recursive relative paths of the files under `dir` (localhost dev tool: it
// reads whatever absolute path the page asks for, so `?folder=<path>` works).
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

const LOCAL = "/@local";

// Serves the tool, character assets under ./assets, and (for `?folder=`) files
// straight off an absolute local path via /@local + a /@list directory index.
const server = Bun.serve({
  port: PORT,
  // Full page reload on change, not HMR: the WebGL renderer holds imperative
  // state that can't be hot-swapped in place.
  development: { hmr: false },
  routes: {
    "/": index,
    "/index.html": index,
  },
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/@list") {
      const dir = url.searchParams.get("dir");
      if (!dir) return new Response("Missing dir", { status: 400 });
      try {
        return Response.json(await listFiles(dir));
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    if (pathname.startsWith(`${LOCAL}/`)) {
      const file = Bun.file(pathname.slice(LOCAL.length));
      if (await file.exists()) return new Response(file);
      return new Response("Not found", { status: 404 });
    }

    const asset = Bun.file(`./assets${pathname}`);
    if (await asset.exists()) return new Response(asset);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Green Room on ${server.url}`);
console.log(`Put characters in ./assets/characters/<name>/ and open ${server.url}?char=<name>`);
console.log(`Or load a folder off disk: ${server.url}?folder=/absolute/path/to/character`);
