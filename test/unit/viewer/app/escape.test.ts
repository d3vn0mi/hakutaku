// escapeHtml: repository text as markup that shows it, and nothing more.
import { expect, it } from "vitest";
import { escapeHtml } from "../../../../src/viewer/app/escape.js";

it("escapes the five characters that markup reads", () => {
  expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
  );
  expect(escapeHtml("</script><script>alert(1)</script>")).toBe(
    "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

it("leaves every other character as it is", () => {
  const other = `plain text, tabs\tand lines\n${String.fromCodePoint(0xe9, 0x1f680)} ~%#:-`;
  expect(escapeHtml(other)).toBe(other);
  expect(escapeHtml("")).toBe("");
});
