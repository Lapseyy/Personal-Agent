/**
 * Policy for the `gog` (gogcli v0.48.0) command line: decides, from the real argument
 * vector, whether a call only reads, only drafts, sends mail, changes something, or is
 * never allowed for the agent. Pure function: no I/O, so every rule is unit-tested.
 *
 * Default deny: a command this table does not recognise as read-only or draft-only needs
 * human approval, and a send whose recipients cannot be verified is blocked outright.
 * Command names and aliases are copied from `gog gmail --help` / `gog calendar --help`.
 */
export type GogActionKind = "read" | "draft" | "send" | "mutate" | "blocked";

export interface GogAction {
  readonly kind: GogActionKind;
  /** Command path only, e.g. "gmail send". Never contains message text or addresses. */
  readonly label: string;
  /** Lower-cased recipients of a send (to + cc + bcc). Empty for everything else. */
  readonly recipients: readonly string[];
  /** Why a call is blocked. Safe to show to the user and the model. */
  readonly reason?: string;
}

export interface GogPolicyOptions {
  /** The only Google account the agent may act as. */
  readonly account: string | undefined;
  /** Addresses the agent may send to. The account itself is always included. */
  readonly allowlist: readonly string[];
}

/** Global flags that take a value (so the next token is not a command word). */
const VALUE_FLAGS = new Set([
  "--color",
  "--home",
  "-a",
  "--account",
  "--client",
  "--access-token",
  "--quota-project",
  "--enable-commands",
  "--enable-commands-exact",
  "--disable-commands",
  "--select",
]);

/** Global boolean flags: they may appear between command words. */
const BOOL_FLAGS = new Set([
  "-h",
  "--help",
  "--gmail-no-send",
  "--readonly",
  "-j",
  "--json",
  "-p",
  "--plain",
  "--wrap-untrusted",
  "--results-only",
  "-n",
  "--dry-run",
  "-y",
  "--force",
  "--no-input",
  "-v",
  "--verbose",
  "--version",
]);

const ALIASES: Readonly<Record<string, string>> = {
  mail: "gmail",
  email: "gmail",
  cal: "calendar",
  find: "search",
  query: "search",
  ls: "list",
  message: "messages",
  msg: "messages",
  msgs: "messages",
  info: "get",
  show: "get",
  threads: "thread",
  label: "labels",
  draft: "drafts",
  replyall: "reply-all",
  fwd: "forward",
  post: "send",
  add: "create",
  new: "create",
  edit: "update",
  set: "update",
  rm: "delete",
  del: "delete",
  remove: "delete",
};

const GMAIL_READ = new Set(["search", "list", "get", "raw", "attachment", "url", "history"]);
const GMAIL_SUB_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  messages: new Set(["search", "list", "get"]),
  thread: new Set(["get"]),
  labels: new Set(["list", "get"]),
  drafts: new Set(["list", "get"]),
};
const DRAFT_ONLY = new Set(["create", "update", "reply", "reply-all", "forward"]);
/** Sends whose recipients come from an existing message or draft and cannot be checked. */
const UNVERIFIABLE_SENDS = new Set(["reply", "reply-all", "autoreply"]);
const CALENDAR_READ = new Set([
  "calendars",
  "acl",
  "events",
  "list",
  "event",
  "get",
  "raw",
  "freebusy",
  "colors",
  "conflicts",
  "changed",
  "search",
  "time",
  "propose-time",
]);

const norm = (word: string): string => ALIASES[word.toLowerCase()] ?? word.toLowerCase();

function flagValues(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === name) {
      const next = argv[i + 1];
      if (next !== undefined) out.push(next);
    } else if (tok.startsWith(`${name}=`)) {
      out.push(tok.slice(name.length + 1));
    }
  }
  return out;
}

const hasFlag = (argv: readonly string[], ...names: string[]): boolean =>
  argv.some((tok) => names.some((n) => tok === n || tok.startsWith(`${n}=`)));

function splitAddresses(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => {
      const angle = /<([^<>]+)>/.exec(v);
      return (angle?.[1] ?? v).trim().toLowerCase();
    })
    .filter((v) => v !== "");
}

const blocked = (label: string, reason: string): GogAction => ({
  kind: "blocked",
  label,
  recipients: [],
  reason,
});

export function classifyGogArgv(argv: readonly string[], opts: GogPolicyOptions): GogAction {
  // Flags that would step outside the one stored, dedicated account.
  if (hasFlag(argv, "--access-token", "--home", "--client")) {
    return blocked("gog", "changing gog's credentials, home or client is not allowed");
  }
  const accounts = [...flagValues(argv, "--account"), ...flagValues(argv, "-a")];
  const own = opts.account?.toLowerCase();
  if (accounts.some((a) => a.toLowerCase() !== own)) {
    return blocked("gog", "only the dedicated test account may be used");
  }

  // Command path = the first words that are not flags or flag values.
  const words: string[] = [];
  let uncertain = false;
  for (let i = 0; i < argv.length && words.length < 3; i++) {
    const tok = argv[i] ?? "";
    if (!tok.startsWith("-")) {
      words.push(norm(tok));
    } else if (VALUE_FLAGS.has(tok)) {
      i++;
    } else if (BOOL_FLAGS.has(tok) || tok.includes("=")) {
      continue;
    } else {
      // An unknown flag whose value may follow. Past this point a word could be a flag
      // value, so stop; if the command path is still incomplete, treat it as unknown.
      uncertain = words.length < 2;
      break;
    }
  }
  const [service, verb, sub] = words;
  const label = [service, verb, sub && GMAIL_SUB_READ[verb ?? ""] ? sub : undefined]
    .filter((w) => w !== undefined)
    .join(" ");

  if (service === undefined || service === "version" || service === "schema") {
    return { kind: "read", label: label || "gog", recipients: [] };
  }
  if (service !== "gmail" && service !== "calendar") {
    return blocked(label, `the "${service}" command is not enabled for this agent`);
  }
  if (uncertain) return { kind: "mutate", label, recipients: [] };
  if (verb === undefined) return { kind: "read", label, recipients: [] }; // prints help
  if (hasFlag(argv, "--dry-run", "-n")) return { kind: "read", label, recipients: [] };

  if (service === "calendar") {
    return { kind: CALENDAR_READ.has(verb) ? "read" : "mutate", label, recipients: [] };
  }

  // gmail
  if (verb === "settings" || verb === "track") {
    return blocked(label, "mail settings and tracking are not enabled for this agent");
  }
  if (GMAIL_READ.has(verb)) return { kind: "read", label, recipients: [] };
  const subRead = GMAIL_SUB_READ[verb];
  if (subRead !== undefined) {
    if (sub !== undefined && subRead.has(sub)) return { kind: "read", label, recipients: [] };
    if (verb === "drafts" && sub !== undefined && DRAFT_ONLY.has(sub)) {
      return { kind: "draft", label, recipients: [] };
    }
    if (verb === "drafts" && sub === "send") {
      return blocked(
        label,
        "a draft's recipients cannot be verified; send with `gog gmail send --to ...` instead",
      );
    }
    return { kind: "mutate", label, recipients: [] };
  }
  if (UNVERIFIABLE_SENDS.has(verb)) {
    return blocked(
      label,
      "recipients cannot be verified; send with `gog gmail send --to ... --thread-id ...` instead",
    );
  }
  if (verb === "send" || verb === "forward") {
    if (hasFlag(argv, "--reply-all", "--raw-file")) {
      return blocked(label, "recipients cannot be verified with --reply-all or --raw-file");
    }
    const recipients = splitAddresses([
      ...flagValues(argv, "--to"),
      ...flagValues(argv, "--cc"),
      ...flagValues(argv, "--bcc"),
    ]);
    if (recipients.length === 0) return blocked(label, "no recipients given with --to");
    const allowed = new Set(
      [...opts.allowlist, ...(own === undefined ? [] : [own])].map((a) => a.toLowerCase()),
    );
    const refused = recipients.filter((r) => !allowed.has(r));
    if (refused.length > 0) {
      return blocked(
        label,
        `${String(refused.length)} recipient(s) are not on the allowlist; nothing was sent`,
      );
    }
    return { kind: "send", label, recipients: [...new Set(recipients)].sort() };
  }
  return { kind: "mutate", label, recipients: [] };
}

/** Parses A3_EMAIL_ALLOWLIST ("a@x.com, b@y.com"). */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a !== "");
}
