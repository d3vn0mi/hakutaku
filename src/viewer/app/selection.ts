// Selecting. A click on the map, a key, a Find pick, a list row and a link token all go through
// select(), which, every time:
//   1. writes the selection's token into the address with history.replaceState, as a whole
//      address: under a <base> element a relative "#token" would drop the ?s= session;
//   2. sets #detail[data-node-id], or data-group for a group of another grouping;
//   3. shows the details header and the breadcrumb;
//   4. moves focus to the header's heading;
//   5. says what is selected in the live region;
//   6. lets the map dim all but the node's neighbours, and flies the camera to it;
//   7. turns the Tests toggle on when the node is a test file;
//   8. switches to Files depth when the depth in use hides the file of the map it selects, its
//      own or its definition's: a depth used for this selection, never remembered (prefs.ts).
// back(), which is Esc, climbs one level: a definition to its file, a file to its component (or
// its group under another grouping), and anything else to no selection, with the whole map in
// view. openToken() opens the node a link token names, and refuses a token the map does not hold.
// Everything here happens at once, in the same task, so the page never shows half a selection.
import type { RepoId } from "../../model/types.js";
import { F, FILE_KINDS } from "../../query/view/constants.js";
import { announcement } from "./announce.js";
import type { DataSource } from "./data-types.js";
import { fileShownAt } from "./depth.js";
import { renderHeader } from "./detail/header.js";
import { showToast } from "./dom.js";
import type { MapView } from "./map/render.js";
import type { Model } from "./model.js";
import { renderCrumbs } from "./panels/crumbs.js";
import {
  addressFor,
  idOf,
  parentOf,
  selFromToken,
  tokenOf,
} from "./routing.js";
import type { Sel, StateStore, Tab, ViewState } from "./state.js";

export interface AppContext {
  repo: RepoId;
  model: Model;
  state: StateStore;
  map: MapView | null; // null: this browser cannot draw the map
  source: DataSource;
}

export interface Selector {
  select(sel: Sel, opts?: { fly?: boolean; tab?: Tab }): void;
  back(): void;
  openToken(token: string): void;
}

const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");
const FALLBACK_MS = 10_000; // a text to copy by hand stays this long

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`the page has no #${id}`);
  return el;
}

export function createSelection(ctx: AppContext): Selector {
  const { model, state, map } = ctx;
  const detail = byId("detail");
  const crumbs = byId("crumbs");
  const live = byId("announce");

  const isTest = (file: number) => {
    const kind = model.map.files[file][F.kind];
    return kind === TEST || kind === TEST_SUPPORT;
  };

  // Copies text to the clipboard and says so; without a clipboard, or when it refuses, the toast
  // shows the text, to copy by hand.
  const copy = (text: string): void => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      showToast(text, { ms: FALLBACK_MS });
      return;
    }
    clipboard.writeText(text).then(
      () => showToast(`Copied ${text}`),
      () => showToast(text, { ms: FALLBACK_MS }),
    );
  };

  const showCrumbs = (sel: Sel) =>
    renderCrumbs(crumbs, model, sel, state.get().group, (to) =>
      to === null ? home() : select(to),
    );

  const select = (sel: Sel, opts: { fly?: boolean; tab?: Tab } = {}): void => {
    const now = state.get();
    const patch: Partial<ViewState> = { sel };
    if (opts.tab !== undefined) patch.tab = opts.tab;
    const file =
      sel !== null && (sel.kind === "file" || sel.kind === "definition")
        ? sel.file
        : -1;
    if (file >= 0 && isTest(file) && !now.show.tests) {
      patch.show = { ...now.show, tests: true };
    }
    // a file off the map is drawn at no depth, so it changes none
    if (
      file >= 0 &&
      model.onMap(file) &&
      !fileShownAt(model, now.depth, file)
    ) {
      patch.depth = "files";
    }
    state.set(patch);
    try {
      history.replaceState(
        history.state,
        "",
        addressFor(location.href, tokenOf(model, sel)),
      );
    } catch {
      // a page whose address cannot change keeps the one it has
    }
    const id = idOf(model, sel);
    if (id === null) detail.removeAttribute("data-node-id");
    else detail.dataset.nodeId = id;
    if (sel?.kind === "group") detail.dataset.group = sel.key;
    else detail.removeAttribute("data-group");
    showCrumbs(sel);
    if (sel === null) {
      detail.replaceChildren();
      detail.hidden = true;
      live.textContent = "";
      return;
    }
    const group = state.get().group;
    detail.replaceChildren(...renderHeader(model, sel, group, copy));
    detail.hidden = false;
    detail.querySelector("h2")?.focus();
    live.textContent = announcement(model, sel, group);
    if (opts.fly !== false) map?.focus(sel, true);
  };

  // No selection, and the whole map in view.
  const home = (): void => {
    select(null);
    map?.fit();
  };

  showCrumbs(state.get().sel);
  return {
    select,
    back() {
      const { sel, group } = state.get();
      const up = parentOf(model, sel, group);
      if (up === null) home();
      else select(up);
    },
    openToken(token) {
      const sel = selFromToken(model, token);
      if (sel === "unknown") showToast(`Not in this map: ${token}`);
      else select(sel);
    },
  };
}
