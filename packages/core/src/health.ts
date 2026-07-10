import { createServer } from "node:http";

export function startHealthServer(port: number, ready: () => boolean = () => true): void {
  createServer((request, response) => {
    const ok = request.url !== "/ready" || ready();
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok, ready: ready() }));
  }).listen(port, "0.0.0.0");
}
