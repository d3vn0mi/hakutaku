// Repository text as HTML that shows it as text: the five characters that markup reads become
// entities. No DOM type here: Node tests import this module.
const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}
