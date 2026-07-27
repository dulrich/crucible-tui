import { describe, expect, test } from "bun:test";
import { resolveFenceLanguage } from "../src/lang";

describe("resolveFenceLanguage — locked alias mapping", () => {
  test("dataviewjs resolves to javascript", () => {
    expect(resolveFenceLanguage("dataviewjs")).toBe("javascript");
  });

  test("dataview resolves to sql", () => {
    expect(resolveFenceLanguage("dataview")).toBe("sql");
  });

  test("unsupported vault languages fall back to plaintext", () => {
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
    expect(resolveFenceLanguage("query")).toBe("plaintext");
    expect(resolveFenceLanguage("mermaid")).toBe("plaintext");
    expect(resolveFenceLanguage("ad-note")).toBe("plaintext");
  });

  test("already-supported languages are left unchanged", () => {
    expect(resolveFenceLanguage("javascript")).toBe("javascript");
    expect(resolveFenceLanguage("sql")).toBe("sql");
    expect(resolveFenceLanguage("bash")).toBe("bash");
  });

  test("mixed case resolves the same as lowercase", () => {
    expect(resolveFenceLanguage("DataviewJS")).toBe("javascript");
  });

  test("marked's info-string tail is discarded; only the first word is looked up", () => {
    expect(resolveFenceLanguage("js {highlight=1}")).toBe("js");
  });

  test("an empty or absent language is returned unchanged, never forced to plaintext", () => {
    expect(resolveFenceLanguage(undefined)).toBe(undefined);
    expect(resolveFenceLanguage("")).toBe("");
  });
});
