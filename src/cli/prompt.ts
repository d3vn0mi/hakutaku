// A yes-or-no question on the terminal.
import { createInterface } from "node:readline";
import type { CliIO } from "./commands/index.js";

// Writes the question and a space to stderr, then reads one line from stdin: "y" or "yes", in
// any case and with any spaces around it, is true. Anything else, or the end of the input, is
// false. Only the first line is read.
export function confirm(io: CliIO, question: string): Promise<boolean> {
  io.stderr(`${question} `);
  return new Promise((done) => {
    const lines = createInterface({ input: io.stdin, terminal: false });
    let answered = false;
    const answer = (line: string | null): void => {
      if (answered) return;
      answered = true;
      lines.close();
      done(line !== null && /^(?:y|yes)$/i.test(line.trim()));
    };
    lines.once("line", (line) => answer(line));
    lines.once("close", () => answer(null));
  });
}
