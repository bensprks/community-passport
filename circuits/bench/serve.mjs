// Serves the built page. The two headers give the page shared memory, which the prover needs to use more than
// one thread.
//
//   node bench/serve.mjs [port]
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };

createServer((request, response) => {
  const path = normalize(new URL(request.url, "http://localhost").pathname);
  const file = join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root) || !existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`http://localhost:${port}`));
