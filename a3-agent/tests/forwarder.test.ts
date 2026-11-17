import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createForwarder } from "../src/local/socksForwarder.ts";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Minimal SOCKS5 server: records the requested target, then pipes to `upstreamPort`. */
function fakeSocks(upstreamPort: number, seen: { host?: string; port?: number }, replyCode = 0) {
  return net.createServer((sock) => {
    sock.once("data", () => {
      sock.write(Buffer.from([5, 0]));
      sock.once("data", (req: Buffer) => {
        seen.host = [...req.subarray(4, 8)].join(".");
        seen.port = req.readUInt16BE(8);
        sock.write(Buffer.from([5, replyCode, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (replyCode !== 0) return sock.end();
        const up = net.connect(upstreamPort, "127.0.0.1");
        sock.pipe(up);
        up.pipe(sock);
        sock.on("close", () => up.destroy());
      });
    });
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    let out = "";
    c.on("data", (d) => (out += d.toString()));
    c.on("close", () => resolve(out));
    // A reset from the forwarder is the same outcome as a clean close: no upstream.
    c.on("error", () => resolve(out));
    c.write(payload);
  });
}

const base = { listenHost: "127.0.0.1", listenPort: 0, socksHost: "127.0.0.1" };

describe("socks forwarder", () => {
  it("pipes bytes both ways and asks SOCKS for the configured tailnet target", async () => {
    const echoPort = await listen(
      net.createServer((s) => s.once("data", (d) => s.end(`echo:${d.toString()}`))),
    );
    const seen: { host?: string; port?: number } = {};
    const socksPort = await listen(fakeSocks(echoPort, seen));
    const fwdPort = await listen(
      createForwarder({
        ...base,
        socksPort,
        targetHost: "100.74.182.24",
        targetPort: 11434,
        connectTimeoutMs: 500,
      }),
    );
    expect(await roundTrip(fwdPort, "GET /api/tags")).toBe("echo:GET /api/tags");
    expect(seen).toEqual({ host: "100.74.182.24", port: 11434 });
  });

  it("closes the client when the desktop is unreachable (SOCKS failure)", async () => {
    const socksPort = await listen(fakeSocks(1, {}, 4));
    const fwdPort = await listen(
      createForwarder({
        ...base,
        socksPort,
        targetHost: "100.74.182.24",
        targetPort: 11434,
        connectTimeoutMs: 500,
      }),
    );
    expect(await roundTrip(fwdPort, "GET /api/tags")).toBe("");
  });

  it("closes the client when the SOCKS proxy itself is down or hangs", async () => {
    const hangPort = await listen(net.createServer(() => undefined));
    const fwdPort = await listen(
      createForwarder({
        ...base,
        socksPort: hangPort,
        targetHost: "100.74.182.24",
        targetPort: 11434,
        connectTimeoutMs: 100,
      }),
    );
    const started = Date.now();
    expect(await roundTrip(fwdPort, "x")).toBe("");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("rejects a non-IPv4 target at construction", () => {
    expect(() =>
      createForwarder({
        ...base,
        socksPort: 1,
        targetHost: "desktop.example",
        targetPort: 1,
        connectTimeoutMs: 1,
      }),
    ).toThrow(/IPv4/);
  });
});
