import net from "node:net";

export interface ForwarderOptions {
  /** Local listen address. Loopback only: nothing outside the container can reach it. */
  readonly listenHost: string;
  readonly listenPort: number;
  /** Tailscale userspace SOCKS5 proxy (tailscaled --socks5-server). */
  readonly socksHost: string;
  readonly socksPort: number;
  /** Ollama on the desktop, as a tailnet IPv4 address and port. */
  readonly targetHost: string;
  readonly targetPort: number;
  /** Give up on the SOCKS handshake after this long (the desktop may be offline). */
  readonly connectTimeoutMs: number;
}

const SOCKS_VERSION = 0x05;

function ipv4Bytes(host: string): Buffer {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("a3-forwarder: target host must be an IPv4 address");
  }
  return Buffer.from(parts);
}

/** Reads exactly `length` bytes from the socket, or rejects on close/error. */
function readExactly(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < length) return;
      cleanup();
      socket.pause();
      const rest = buffered.subarray(length);
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffered.subarray(0, length));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socks proxy closed during handshake"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

/**
 * Opens a TCP connection to the target through the SOCKS5 proxy (no auth, CONNECT, IPv4).
 * Resolves with a socket that is a raw byte pipe to the target.
 */
export async function connectViaSocks(opts: ForwarderOptions): Promise<net.Socket> {
  const socket = net.connect({ host: opts.socksHost, port: opts.socksPort });
  socket.setTimeout(opts.connectTimeoutMs, () => {
    socket.destroy(new Error("socks handshake timed out"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(Buffer.from([SOCKS_VERSION, 0x01, 0x00]));
    const greeting = await readExactly(socket, 2);
    if (greeting[0] !== SOCKS_VERSION || greeting[1] !== 0x00) {
      throw new Error("socks proxy rejected the no-auth method");
    }
    const port = Buffer.alloc(2);
    port.writeUInt16BE(opts.targetPort);
    socket.write(
      Buffer.concat([
        Buffer.from([SOCKS_VERSION, 0x01, 0x00, 0x01]),
        ipv4Bytes(opts.targetHost),
        port,
      ]),
    );
    const reply = await readExactly(socket, 10);
    if (reply[0] !== SOCKS_VERSION || reply[1] !== 0x00) {
      throw new Error(`socks connect failed with code ${String(reply[1])}`);
    }
    socket.setTimeout(0);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * Loopback TCP forwarder: every connection to listenHost:listenPort is piped to the desktop's
 * Ollama through the Tailscale SOCKS5 proxy. Only this path uses the tailnet; cloud-provider
 * calls never touch it. If the desktop is unreachable the client connection is closed, which
 * the router's health probe reads as "local unavailable".
 */
export function createForwarder(opts: ForwarderOptions): net.Server {
  ipv4Bytes(opts.targetHost);
  return net.createServer({ pauseOnConnect: true }, (client) => {
    client.on("error", () => client.destroy());
    connectViaSocks(opts).then(
      (upstream) => {
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      },
      () => client.destroy(),
    );
  });
}
