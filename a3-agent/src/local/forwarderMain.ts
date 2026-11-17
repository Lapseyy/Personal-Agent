import { z } from "zod";
import { createForwarder } from "./socksForwarder.ts";

const envSchema = z.object({
  A3_FORWARDER_LISTEN_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  A3_FORWARDER_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(11435),
  A3_SOCKS_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  A3_SOCKS_PORT: z.coerce.number().int().min(1).max(65535).default(1055),
  A3_OLLAMA_TAILNET_HOST: z.ipv4(),
  A3_OLLAMA_TAILNET_PORT: z.coerce.number().int().min(1).max(65535).default(11434),
  A3_FORWARDER_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  console.error(`a3-forwarder: invalid or missing configuration for: ${fields}`);
  process.exit(1);
}
const env = parsed.data;

const server = createForwarder({
  listenHost: env.A3_FORWARDER_LISTEN_HOST,
  listenPort: env.A3_FORWARDER_LISTEN_PORT,
  socksHost: env.A3_SOCKS_HOST,
  socksPort: env.A3_SOCKS_PORT,
  targetHost: env.A3_OLLAMA_TAILNET_HOST,
  targetPort: env.A3_OLLAMA_TAILNET_PORT,
  connectTimeoutMs: env.A3_FORWARDER_CONNECT_TIMEOUT_MS,
});

server.listen(env.A3_FORWARDER_LISTEN_PORT, env.A3_FORWARDER_LISTEN_HOST, () => {
  console.log(
    JSON.stringify({
      severity: "INFO",
      component: "a3-forwarder",
      event: "listening",
      listen: `${env.A3_FORWARDER_LISTEN_HOST}:${String(env.A3_FORWARDER_LISTEN_PORT)}`,
    }),
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
