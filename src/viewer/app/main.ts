// The page's start: read the map from the page's data source, name the repo and its build in the
// title and the brand, then build the model and lay out the panels and the map around one view
// state, and open the node the address's link token names. html[data-ready] says how far it got:
// "loading", then "data" once the map has arrived, then "map" once the map is drawn, or "nomap"
// when this browser cannot draw it; or "error" with #fatal saying why.
import "./styles/app.css";
import type { MapData } from "../../query/view/types.js";
import { guardBuild } from "./build-guard.js";
import { pickSource } from "./data.js";
import { ApiError, type DataSource } from "./data-types.js";
import { prefersReducedMotion, showToast } from "./dom.js";
import { bindKeys } from "./keys.js";
import { mountMap } from "./map/render.js";
import { buildModel } from "./model.js";
import { drawTimeline, fillRankLists } from "./panels/bottom.js";
import { mountLegend } from "./panels/legend.js";
import { mountShow } from "./panels/show.js";
import { mountStatband } from "./panels/statband.js";
import { loadPrefs } from "./prefs.js";
import { createSelection, type Selector } from "./selection.js";
import { createState, NO_FILTERS, type ViewState } from "./state.js";

const SEP = " \u00b7 ";
const NOT_BUILT =
  "This repo has no map yet. Run: hakutaku map <path to the repo>";
const NO_WEBGL =
  "This browser cannot draw the map (no WebGL). The list view shows the same files.";

// The view the page opens with: Files depth, Structure lens, grouped by component, tests hidden.
const START: ViewState = {
  lens: "structure",
  depth: "files",
  group: "component",
  entriesOn: false,
  show: { production: true, tests: false, libraries: true, curves: true },
  sel: null,
  tab: "overview",
  wide: false,
  filters: NO_FILTERS,
  listOpen: false,
};

function setReady(state: "loading" | "data" | "nomap" | "error"): void {
  document.documentElement.dataset.ready = state;
}

function byId<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`the page has no #${id}`);
  return el as unknown as T;
}

function showFatal(e: unknown): void {
  const fatal = document.getElementById("fatal");
  if (fatal !== null) {
    fatal.textContent = failure(e);
    fatal.hidden = false;
  }
  setReady("error");
}

// Why the map did not load, by the error's code; an answer that carried no error reads internal.
function failure(e: unknown): string {
  const code = e instanceof ApiError ? e.error.code : "internal";
  return code === "not_built"
    ? NOT_BUILT
    : `The map could not be loaded (${code}).`;
}

// The repo and its build, and whether the build may be behind the repo.
function brandOf(map: MapData): string {
  const freshness =
    map.stale === true
      ? `${SEP}stale`
      : map.stale === "unknown"
        ? `${SEP}freshness unknown`
        : "";
  return `${map.repo}${SEP}${map.builtCommit}${freshness}`;
}

// The model, the view state, the panels, the map and the selection. The panels and the
// selection never wait for the map, so they work in a browser that cannot draw it, and the
// change activity fills in when it arrives. The address's token is opened in the same task that
// draws the map's first frame, so a page that says it is ready already shows that node.
function compose(map: MapData, fetched: DataSource): void {
  const model = buildModel(map);
  // the remembered lens, depth and grouping over the defaults; storage may be missing or throw
  const state = createState({
    ...START,
    ...loadPrefs(() => localStorage, map.repo),
  });
  // every later answer is checked against the build this map came from
  const source = guardBuild(fetched, map.builtCommit, (commit) =>
    showToast(`The map was rebuilt at ${commit}. Reload to see it.`, {
      action: { label: "Reload", run: () => location.reload() },
    }),
  );
  prefersReducedMotion(); // records html[data-motion] from the start
  mountLegend(byId("legend"));
  mountStatband(byId("statband"), model, state);
  mountShow(byId("show"), model, state);
  // the map's clicks select through the selection, which needs the map: it is made right after
  let selector: Selector | null = null;
  const view = mountMap(byId("map"), model, state, {
    node: (sel) => selector?.select(sel),
    stage: () => selector?.select(null),
  });
  const selection = createSelection({
    repo: map.repo,
    model,
    state,
    map: view,
    source,
  });
  selector = selection;
  fillRankLists(byId("core-list"), byId("hot-list"), model, (file) =>
    selection.select({ kind: "file", file }),
  );
  bindKeys({ back: () => selection.back() });
  byId("back-btn").addEventListener("click", () => selection.back());
  addEventListener("hashchange", () =>
    selection.openToken(location.hash.slice(1)),
  );
  source.history().then(
    (history) => drawTimeline(byId<SVGSVGElement>("timeline"), history),
    (e) =>
      console.error("hakutaku: the change activity could not be loaded", e),
  );
  if (view === null) {
    const notice = byId<HTMLElement>("map-notice");
    notice.textContent = NO_WEBGL;
    notice.hidden = false;
    selection.openToken(location.hash.slice(1));
    setReady("nomap");
    return;
  }
  byId("zoom-in").addEventListener("click", () => view.zoom(1));
  byId("zoom-out").addEventListener("click", () => view.zoom(-1));
  byId("zoom-fit").addEventListener("click", () => view.fit());
  selection.openToken(location.hash.slice(1));
}

async function start(): Promise<void> {
  setReady("loading");
  let source: DataSource;
  let map: MapData;
  try {
    source = pickSource(document, location);
    map = await source.map();
  } catch (e) {
    console.error("hakutaku: the map could not be loaded", e);
    showFatal(e);
    return;
  }
  document.title = `hakutaku${SEP}${map.repo}`;
  const brand = document.querySelector(".brand");
  if (brand !== null) brand.textContent = brandOf(map);
  setReady("data");
  try {
    compose(map, source);
  } catch (e) {
    console.error("hakutaku: the map could not be drawn", e);
    showFatal(e);
  }
}

void start();
