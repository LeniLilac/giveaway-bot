import { createServer, type Server } from "node:http";

export interface HealthServerOptions {
  port: number;
  checks?: Record<string, () => void | Promise<void>>;
}

export function startHealthServer(
  optionsOrPort: HealthServerOptions | number,
  legacyReady: () => boolean = () => true,
): Server {
  const options =
    typeof optionsOrPort === "number"
      ? {
          port: optionsOrPort,
          checks: {
            ready: () => {
              if (!legacyReady()) throw new Error("Service is not ready.");
            },
          },
        }
      : optionsOrPort;

  const server = createServer(async (request, response) => {
    const results: Record<string, { ok: boolean }> = {};
    let ok = true;
    for (const [name, check] of Object.entries(options.checks ?? {})) {
      try {
        await check();
        results[name] = { ok: true };
      } catch {
        ok = false;
        results[name] = { ok: false };
      }
    }
    const status = request.url === "/health" || request.url === "/ready" ? (ok ? 200 : 503) : 404;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: status === 200, checks: results }));
  });
  server.listen(options.port, "0.0.0.0");
  return server;
}

export function closeHealthServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
