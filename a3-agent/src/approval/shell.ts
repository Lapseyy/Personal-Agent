/**
 * Best-effort extraction of `gog` invocations from a shell command string, so the plugin
 * can ask the human before the command runs. This is deliberately NOT the security
 * boundary: a command it fails to recognise still meets the gog wrapper, which checks the
 * real argument vector and refuses to send without an approval token.
 */
export interface GogInvocations {
  readonly calls: readonly (readonly string[])[];
  /** The text mentions gog (or the real binary) in a way that could not be parsed. */
  readonly suspicious: boolean;
  /** First word of each simple command, reduced to a safe name. For logs only. */
  readonly heads: readonly string[];
}

const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "stdbuf",
  "timeout",
  "nice",
]);
/** Options and durations that wrappers such as `timeout 30s` or `nice -n 5` take. */
const WRAPPER_ARG = /^(-.*|\d+(\.\d+)?[smhd]?)$/;
const SAFE_HEAD = /^[A-Za-z0-9._-]{1,24}$/;
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);

/** Splits into simple commands, then words. Handles quotes and backslashes only. */
export function tokenizeShell(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | undefined;
  // Redirections (`2>&1`, `> out.txt`, `<in`) are not arguments: drop them and their target.
  let dropNext = false;
  const endWord = () => {
    if (has) {
      if (dropNext) dropNext = false;
      else words.push(cur);
    }
    cur = "";
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i] ?? "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i] ?? "";
      has = true;
    } else if (ch === ">" || ch === "<") {
      if (/^\d*$/.test(cur)) {
        cur = ""; // file descriptor number such as the 2 in 2>
        has = false;
      } else endWord();
      let j = i + 1;
      while (command[j] === ">" || command[j] === "|") j++;
      if (command[j] === "&" && /[\d-]/.test(command[j + 1] ?? "")) {
        j += 2; // 2>&1, >&- : no file target follows
      } else {
        dropNext = true;
      }
      i = j - 1;
    } else if (ch === "&" && command[i + 1] === ">") {
      endWord(); // &> file
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (";&|\n()`".includes(ch)) {
      endCommand();
    } else if (ch === "$" && command[i + 1] === "(") {
      endCommand();
      i++;
    } else {
      cur += ch;
      has = true;
    }
  }
  endCommand();
  return commands;
}

const JS_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/**
 * String literals in JavaScript source. OpenClaw's code tool lets the model write
 * `await exec({command: "gog gmail send ..."})`, so the shell command arrives inside a JS
 * string. Template literals with `${...}` are returned as-is; they still contain "gog" and,
 * being unparseable, are treated as unparsed text by the gate.
 */
export function extractJsStrings(code: string): string[] {
  const out: string[] = [];
  const re = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const m of code.matchAll(re)) {
    const quote = m[1] ?? "";
    const body = m[2] ?? "";
    if (quote === "`" && body.includes("${")) {
      out.push(body);
      continue;
    }
    out.push(body.replace(/\\([\s\S])/g, (_, c: string) => JS_ESCAPES[c] ?? c));
  }
  return out;
}

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

export function findGogInvocations(command: string, depth = 0): GogInvocations {
  const calls: string[][] = [];
  const heads: string[] = [];
  let suspicious = /gog-real|libexec/.test(command);
  for (const words of tokenizeShell(command)) {
    let i = 0;
    for (;;) {
      const w = words[i] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
      else if (WRAPPERS.has(w)) {
        i++;
        while (i < words.length && WRAPPER_ARG.test(words[i] ?? "")) i++;
      } else break;
    }
    const head = basename(words[i] ?? "");
    if (head !== "") heads.push(SAFE_HEAD.test(head) ? head : "?");
    if (head === "gog") {
      calls.push(words.slice(i + 1));
    } else if (SHELLS.has(head) && depth < 3) {
      const c = words.findIndex((w, idx) => idx > i && /^-[a-z]*c$/.test(w));
      const script = c >= 0 ? words[c + 1] : undefined;
      if (script !== undefined) {
        const inner = findGogInvocations(script, depth + 1);
        calls.push(...inner.calls.map((x) => [...x]));
        suspicious ||= inner.suspicious;
      }
    }
  }
  if (calls.length === 0 && /\bgog\b/.test(command)) suspicious = true;
  return { calls, suspicious, heads };
}
