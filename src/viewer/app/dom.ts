// Building the page's elements safely: text goes in through textContent and attributes through
// setAttribute, never markup from a string, and never a style attribute or an inline handler.
// Also the toast, and the reduced-motion wish. Node tests never import this module.

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

export interface ToastAction {
  label: string;
  run(): void;
}

const TOAST_MS = 4000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let notice: { text: string; action: ToastAction } | null = null;

// The toast over the map, in #toast, as text. A message shows for ms milliseconds, then the toast
// hides and keeps its text. A notice that carries an action, such as a rebuild's Reload, stays,
// and comes back after any message shown over it.
export function showToast(
  text: string,
  opts: { action?: ToastAction; ms?: number } = {},
): void {
  const toast = document.getElementById("toast");
  if (toast === null) return;
  const show = (message: string, action?: ToastAction) => {
    toast.replaceChildren(message);
    if (action !== undefined) {
      toast.append(
        " ",
        h("button", {
          text: action.label,
          attrs: { type: "button" },
          on: { click: () => action.run() },
        }),
      );
    }
    toast.hidden = false;
  };
  clearTimeout(toastTimer);
  if (opts.action !== undefined) {
    notice = { text, action: opts.action };
    show(text, opts.action);
    return;
  }
  show(text);
  toastTimer = setTimeout(() => {
    if (notice === null) toast.hidden = true;
    else show(notice.text, notice.action);
  }, opts.ms ?? TOAST_MS);
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
