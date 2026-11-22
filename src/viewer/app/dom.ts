// Building the page's elements safely: text goes in through textContent and attributes through
// setAttribute, never markup from a string, and never a style attribute or an inline handler.
// Node tests never import this module.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    class?: string;
    text?: string;
    attrs?: Record<string, string>;
    on?: Record<string, (e: Event) => void>;
  } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class !== undefined) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    // A style attribute breaks the CSP's style-src, and an inline handler is code from a string.
    if (/^(style$|on)/i.test(name)) {
      throw new TypeError(`h() never sets the attribute ${name}`);
    }
    el.setAttribute(name, value);
  }
  for (const [type, listener] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, listener);
  }
  el.append(...children);
  return el;
}

// Whether the viewer asks for reduced motion, which it also records as html[data-motion]:
// "reduce" or "full".
export function prefersReducedMotion(): boolean {
  const reduce =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.dataset.motion = reduce ? "reduce" : "full";
  return reduce;
}
