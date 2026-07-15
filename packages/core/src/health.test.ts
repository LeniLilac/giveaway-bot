import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeHealthServer, startHealthServer } from "./health.js";

const servers = new Set<ReturnType<typeof startHealthServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => closeHealthServer(server)));
  servers.clear();
});

describe("health server lifecycle", () => {
  it("returns a server that can be closed cleanly", async () => {
    const server = startHealthServer({ port: 0 });
    servers.add(server);
    await once(server, "listening");

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, checks: {} });

    await closeHealthServer(server);
    servers.delete(server);
    expect(server.listening).toBe(false);
  });

  it("treats closing an already closed server as successful", async () => {
    const server = startHealthServer({ port: 0 });
    await once(server, "listening");

    await closeHealthServer(server);
    await expect(closeHealthServer(server)).resolves.toBeUndefined();
  });
});
