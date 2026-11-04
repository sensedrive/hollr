import { describe, expect, test } from "bun:test";
import { detectLanguage, SAMPLES, SPEECH_LANGS, speakable, SUMMARY_SAMPLES, summaryKey } from "./speechText";

test("each settings sample is read in its own language", () => {
  for (const l of SPEECH_LANGS) {
    expect(detectLanguage(SAMPLES[l], l === "de" ? "en" : "de")).toBe(l);
    expect(speakable(SAMPLES[l])).toBe(SAMPLES[l]);
  }
});

describe("speakable", () => {
  test("markdown syntax goes, the words stay", () => {
    expect(speakable("## Ergebnis\n\nDas ist **fett**, _kursiv_ und `npm test` mit [Link](https://x.y/z).")).toBe(
      "Ergebnis.\nDas ist fett, kursiv und npm test mit Link.",
    );
  });

  test("snake_case and stars in math stay", () => {
    expect(speakable("Set max_tokens_per_chunk to 2 * 3 * 4")).toBe("Set max_tokens_per_chunk to 2 * 3 * 4");
  });

  test("list items and headings become sentences, wrapped lines join", () => {
    expect(speakable("Changes:\n- first item\n- second item!\n1. third\n\nA long line that the terminal\nwrapped in two.")).toBe(
      "Changes:\nfirst item.\nsecond item!\nthird.\nA long line that the terminal wrapped in two.",
    );
  });

  test("code blocks are skipped in prose", () => {
    const md = "Run this:\n\n```bash\nbun test\nrm -rf node_modules\n```\n\nThen it works.";
    expect(speakable(md)).toBe("Run this:\nThen it works.");
  });

  test("only code selected: the code is read", () => {
    expect(speakable("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    // the selection started inside a code block: an unclosed fence
    expect(speakable("Erklärung.\n```\nfoo()")).toBe("Erklärung.");
  });

  test("URLs are read as their host", () => {
    expect(speakable("Siehe https://github.com/gradium-ai/xn-ptts/blob/main/README.md.")).toBe("Siehe github.com.");
    expect(speakable("<https://www.example.org/a?b=c>")).toBe("example.org");
  });

  test("tables read row by row", () => {
    expect(speakable("| Name | Größe |\n|---|---:|\n| base | 148 MB |")).toBe("Name, Größe.\nbase, 148 MB.");
  });

  test("TUI chrome and ANSI are dropped", () => {
    const tui = "╭──────────────╮\n│ ⏺ Fertig: die Tests laufen. │\n╰──────────────╯\n  ⎿  Read 42 lines\n\x1b[1mbold\x1b[0m";
    expect(speakable(tui)).toBe("Fertig: die Tests laufen. Read 42 lines bold");
  });

  test("quotes, rules, task lists and html", () => {
    expect(speakable("> zitiert\n\n---\n\n- [x] erledigt\n- [ ] offen<br>")).toBe("zitiert\nerledigt.\noffen.");
  });

  test("nothing to say", () => {
    expect(speakable("  \n━━━━\n│ │")).toBe("");
  });
});

describe("detectLanguage", () => {
  test("German, also with English tech terms", () => {
    expect(detectLanguage("Ich habe den Build gefixt und die Tests laufen wieder.", "en")).toBe("de");
    expect(detectLanguage("Der Merge-Request ist fertig, bitte noch das Review machen.", "en")).toBe("de");
  });

  test("English", () => {
    expect(detectLanguage("The build is fixed and all tests are passing again.", "de")).toBe("en");
    expect(detectLanguage("Fix the bug", "de")).toBe("en");
  });

  test("French, Spanish, Portuguese", () => {
    expect(detectLanguage("Le serveur est prêt et les tests sont verts.", "de")).toBe("fr");
    expect(detectLanguage("El servidor está listo y las pruebas pasan también.", "de")).toBe("es");
    expect(detectLanguage("O servidor está pronto e os testes não falham mais.", "de")).toBe("pt");
  });

  test("umlauts tip it to German", () => {
    expect(detectLanguage("Größenänderung übernommen", "en")).toBe("de");
  });

  test("no clue: the fallback", () => {
    expect(detectLanguage("TENDR-725 cargo clippy", "de")).toBe("de");
    expect(detectLanguage("TENDR-725 cargo clippy", "en")).toBe("en");
    expect(detectLanguage("", "en")).toBe("en");
  });
});

describe("summaries", () => {
  test("the cache key tells texts, models and lengths apart", () => {
    const key = summaryKey("Hallo Welt", "anthropic/claude-haiku-5-5", "kurz");
    expect(summaryKey("Hallo Welt", "anthropic/claude-haiku-5-5", "kurz")).toBe(key);
    expect(summaryKey("Hallo Welt!", "anthropic/claude-haiku-5-5", "kurz")).not.toBe(key);
    expect(summaryKey("Hallo Welt", "", "kurz")).not.toBe(key);
    expect(summaryKey("Hallo Welt", "anthropic/claude-haiku-5-5", "mittel")).not.toBe(key);
    expect(key.endsWith("|anthropic/claude-haiku-5-5|kurz")).toBe(true);
  });

  test("the samples are detected in their language", () => {
    expect(detectLanguage(speakable(SUMMARY_SAMPLES.de), "en")).toBe("de");
    expect(detectLanguage(speakable(SUMMARY_SAMPLES.en), "de")).toBe("en");
  });
});
