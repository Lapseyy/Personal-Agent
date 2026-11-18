import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Sessions that have contained a privacy-sensitive turn. The router classifies one message
 * at a time, but OpenClaw sends the whole session transcript to whichever model answers.
 * Without this, a private exchange answered locally would be sent to the cloud as history
 * on the next cloud-routed turn. Once a session is listed here it stays local-only (or HELD)
 * until the user starts a new session (/new gives a new session id).
 */
export interface PrivateSessionStore {
  has(sessionRef: string): boolean;
  add(sessionRef: string): void;
  /** Forget a session (the user started a new conversation with /new or /reset). */
  delete(sessionRef: string): void;
}

const MAX_SESSIONS = 2_000;

export class InMemoryPrivateSessionStore implements PrivateSessionStore {
  readonly #refs = new Set<string>();

  has(sessionRef: string): boolean {
    return this.#refs.has(sessionRef);
  }

  add(sessionRef: string): void {
    this.#refs.add(sessionRef);
  }

  delete(sessionRef: string): void {
    this.#refs.delete(sessionRef);
  }
}

/**
 * File-backed store kept inside the OpenClaw state directory, so it is captured by the same
 * snapshot as the session transcripts it protects and is restored together with them.
 *
 * Fail closed: if the file exists but cannot be read as a list of strings, every session is
 * treated as private until the file is repaired or removed. A write failure keeps the entry
 * in memory and never throws, because an exception inside a routing hook must not let a turn
 * fall through to the default (cloud) model.
 */
export class FilePrivateSessionStore implements PrivateSessionStore {
  readonly #file: string;
  readonly #refs = new Set<string>();
  #failClosed = false;

  constructor(file: string) {
    this.#file = file;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      // A missing file is the normal first run. Anything else is unreadable state.
      this.#failClosed = (err as NodeJS.ErrnoException).code !== "ENOENT";
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        this.#failClosed = true;
        return;
      }
      for (const ref of parsed as string[]) this.#refs.add(ref);
    } catch {
      this.#failClosed = true;
    }
  }

  /** True when the stored list was unreadable and every session is being kept local. */
  get failClosed(): boolean {
    return this.#failClosed;
  }

  has(sessionRef: string): boolean {
    return this.#failClosed || this.#refs.has(sessionRef);
  }

  add(sessionRef: string): void {
    if (this.#refs.has(sessionRef)) return;
    this.#refs.add(sessionRef);
    while (this.#refs.size > MAX_SESSIONS) {
      const oldest = this.#refs.values().next().value;
      if (oldest === undefined) break;
      this.#refs.delete(oldest);
    }
    this.#persist();
  }

  delete(sessionRef: string): void {
    if (!this.#refs.delete(sessionRef)) return;
    this.#persist();
  }

  #persist(): void {
    if (this.#failClosed) return; // never overwrite a file we could not read
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.#refs]), { mode: 0o600 });
      renameSync(tmp, this.#file); // atomic on the local state disk
    } catch {
      // Kept in memory for this process; see class comment.
    }
  }
}
