import index from "./index.html";

const PORT = Number(process.env.PORT ?? 3000);

// Serves the tool and any character assets placed under ./assets
// (so ./assets/characters/<name>/ is reachable at /characters/<name>/).
const server = Bun.serve({
  port: PORT,
  development: true,
  routes: {
    "/": index,
    "/index.html": index,
  },
  async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    const asset = Bun.file(`./assets${pathname}`);
    if (await asset.exists()) return new Response(asset);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Green Room on ${server.url}`);
console.log(`Put characters in ./assets/characters/<name>/ and open ${server.url}?char=<name>`);
