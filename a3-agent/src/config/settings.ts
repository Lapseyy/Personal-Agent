import { z } from "zod";

const settingsSchema = z.object({
  localProvider: z.string().min(1).default("ollama"),
  localModel: z.string().min(1).default("gemma4:e4b"),
  cloudProvider: z.string().min(1).default("openai"),
  cloudModel: z.string().min(1).default("gpt-5.6-sol"),
  /** In-container forwarder that tunnels to the desktop over the Tailscale SOCKS5 proxy. */
  ollamaBaseUrl: z.url().default("http://127.0.0.1:11435"),
  healthTimeoutMs: z.coerce.number().int().positive().max(10_000).default(3_000),
  healthCacheMs: z.coerce.number().int().nonnegative().default(5_000),
  cloudCooldownMs: z.coerce.number().int().positive().default(300_000),
  /** After a local model call times out or errors, treat local as unavailable this long. */
  localCooldownMs: z.coerce.number().int().positive().default(300_000),
  longContextChars: z.coerce.number().int().positive().default(24_000),
  simpleMaxChars: z.coerce.number().int().positive().default(400),
  /** Reversible rate-limit simulation: if this file exists the cloud counts as rate limited. */
  rateLimitFlagFile: z.string().min(1).optional(),
  /** Same switch as an env var (A3_SIMULATE_CLOUD_429=1). Never touches real quota. */
  simulateCloud429: z.boolean().default(false),
  heldMessage: z
    .string()
    .min(1)
    .default(
      "I can't process that privately right now because the local model is offline. " +
        "Nothing was sent to any model. Please try again when the local model is back online.",
    ),
  heldSessionMessage: z
    .string()
    .min(1)
    .default(
      "This conversation contains private content, so I only answer it with the local model, " +
        "and the local model is offline. Nothing was sent to any model. Try again when it is " +
        "back online, or send /new to start a fresh conversation.",
    ),
  /** Where the list of private sessions is kept. Default: inside the OpenClaw state dir. */
  privateSessionsFile: z.string().min(1).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    A3_LOCAL_PROVIDER: "localProvider",
    A3_LOCAL_MODEL: "localModel",
    A3_CLOUD_PROVIDER: "cloudProvider",
    A3_CLOUD_MODEL: "cloudModel",
    A3_OLLAMA_BASE_URL: "ollamaBaseUrl",
    A3_HEALTH_TIMEOUT_MS: "healthTimeoutMs",
    A3_CLOUD_COOLDOWN_MS: "cloudCooldownMs",
    A3_LOCAL_COOLDOWN_MS: "localCooldownMs",
    A3_RATE_LIMIT_FLAG_FILE: "rateLimitFlagFile",
    A3_PRIVATE_SESSIONS_FILE: "privateSessionsFile",
  };
  for (const [name, key] of Object.entries(map)) {
    const value = env[name];
    if (value !== undefined && value !== "") out[key] = value;
  }
  if (env["A3_SIMULATE_CLOUD_429"] === "1") out["simulateCloud429"] = true;
  return out;
}

/**
 * Plugin config (openclaw.json) overridden by environment variables. Fails fast with the
 * names of the bad fields; never prints values.
 */
export function loadSettings(
  pluginConfig: Record<string, unknown> | undefined,
  env: Env,
): Settings {
  const parsed = settingsSchema.safeParse({ ...(pluginConfig ?? {}), ...fromEnv(env) });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`a3-router: invalid configuration for: ${fields}`);
  }
  return parsed.data;
}
