import { describe, expect, it } from "vitest";
import { classifyTask, taskTypeOf } from "../src/router/classify.ts";

const opts = { longContextChars: 1000, simpleMaxChars: 100 };
const classify = (text: string, heavyAttachments = 0) =>
  classifyTask({ text, heavyAttachments }, opts);

describe("classifyTask", () => {
  it("flags private content", () => {
    for (const t of [
      "my bank account number is on the note",
      "remember my password for the wifi",
      "[private] what did the doctor say",
      "summarize my medical results",
      "keep this private: I am switching jobs",
    ]) {
      expect(classify(t).privacy_sensitive, t).toBe(true);
    }
  });

  it("does not flag ordinary requests as private", () => {
    for (const t of ["What is 12 times 9?", "what's the weather tomorrow", "why is the sky blue"]) {
      expect(classify(t).privacy_sensitive, t).toBe(false);
    }
  });

  it("regression: access codes in everyday wording are private", () => {
    // Found in live testing: this message was routed as an ordinary short task.
    for (const t of [
      "I will give you my gym locker code: 1123.",
      "the door code is 4471",
      "my PIN is 0000",
      "what was the alarm code again",
    ]) {
      expect(classify(t).privacy_sensitive, t).toBe(true);
    }
  });

  it("the word 'code' or 'pin' alone does not make a message private", () => {
    for (const t of ["debug my Python code", "pin this message for later", "what is a zip code"]) {
      expect(classify(t).privacy_sensitive, t).toBe(false);
    }
  });

  it("short arithmetic is simple", () => {
    const p = classify("What is 12 times 9?");
    expect(p).toMatchObject({ simple: true, reasoning_heavy: false });
    expect(taskTypeOf(p)).toBe("simple");
  });

  it("calendar, email, search and weather requests need tools and are not simple", () => {
    for (const t of [
      "What's on my calendar this week?",
      "Any unread email?",
      "Draft an email to Sam",
      "What's the weather tomorrow?",
      "Search the web for OpenClaw releases",
    ]) {
      const p = classify(t);
      expect(p.needs_tools, t).toBe(true);
      expect(p.simple, t).toBe(false);
      expect(taskTypeOf(p), t).toBe("tool_use");
    }
    expect(classify("What is 12 times 9?").needs_tools).toBe(false);
  });

  it("'why' and analysis prompts are reasoning-heavy and not simple", () => {
    for (const t of ["why is the sky blue", "Compare Postgres and MySQL and plan a migration"]) {
      const p = classify(t);
      expect(p.reasoning_heavy, t).toBe(true);
      expect(p.simple, t).toBe(false);
    }
  });

  it("long prompts and document attachments need long context", () => {
    expect(classify("x".repeat(1001)).needs_long_context).toBe(true);
    expect(classify("read this", 1).needs_long_context).toBe(true);
    expect(classify("read this", 0).needs_long_context).toBe(false);
  });

  it("is deterministic", () => {
    const t = "Analyze my salary history";
    expect(classify(t)).toEqual(classify(t));
  });

  it("private wins the task_type label", () => {
    expect(taskTypeOf(classify("analyze my salary history"))).toBe("private");
  });
});
