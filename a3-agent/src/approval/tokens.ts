import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ApprovedKind = "send" | "mutate";

export interface ApprovalToken {
  readonly kind: ApprovedKind;
  /** Sorted, lower-cased recipients the human saw when approving a send. */
  readonly recipients: readonly string[];
  readonly expiresAt: number;
}

/**
 * One single-use approval at a time, written by the plugin when the human answers
 * "allow once" and consumed by the gog wrapper. A token is valid only for the kind of
 * action and the exact recipient set the human approved, and only until it expires.
 */
export class ApprovalTokenStore {
  readonly #file: string;
  readonly #now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  grant(kind: ApprovedKind, recipients: readonly string[], ttlMs: number): void {
    const token: ApprovalToken = {
      kind,
      recipients: [...recipients].sort(),
      expiresAt: this.#now() + ttlMs,
    };
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  /**
   * True if an unexpired token for exactly this action is waiting, without using it up.
   * Lets the plugin skip a second prompt when the same approved command reaches the hook
   * again (the code tool's inner `exec`). Only the wrapper consumes the token.
   */
  pending(kind: ApprovedKind, recipients: readonly string[]): boolean {
    let token: ApprovalToken;
    try {
      token = JSON.parse(readFileSync(this.#file, "utf8")) as ApprovalToken;
    } catch {
      return false;
    }
    const wanted = [...recipients].sort();
    return (
      token.kind === kind &&
      typeof token.expiresAt === "number" &&
      token.expiresAt > this.#now() &&
      Array.isArray(token.recipients) &&
      token.recipients.length === wanted.length &&
      token.recipients.every((r, i) => r === wanted[i])
    );
  }

  /** True exactly once for a matching, unexpired token. Any read or parse failure is "no". */
  consume(kind: ApprovedKind, recipients: readonly string[]): boolean {
    if (!this.pending(kind, recipients)) return false;
    try {
      rmSync(this.#file);
    } catch {
      return false; // could not be made single-use, so do not honour it
    }
    return true;
  }
}

export function approvalTokenPath(stateDir: string): string {
  return `${stateDir}/a3-router/approval-token.json`;
}
