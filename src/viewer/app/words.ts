// Counting words, for every count the page writes: one thing in the singular, any other number in
// the plural, and whole numbers grouped as en-US writes them (1,204). No DOM here: Node tests
// import it.

// n with en-US grouping.
export function whole(n: number): string {
  return n.toLocaleString("en-US");
}

// The word for n things, without the number, for a count whose number is written apart from
// it: "file" for 1, "files" for any other n; many is the plural when adding an "s" does not make
// it ("libraries").
export function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

// n and the word for n things: "1 file", "2 files", "0 files".
export function count(n: number, one: string, many = `${one}s`): string {
  return `${whole(n)} ${noun(n, one, many)}`;
}
