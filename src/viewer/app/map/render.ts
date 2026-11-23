// The map: sigma draws the files, hubs and libraries with WebGL over a graphology graph, and the
// import curves are drawn on the canvas beneath it after each of sigma's frames. The curves are
// picked when the view state changes; a frame only redraws them.
// - Node keys: f<file index>, h<hub index>, x<library index>.
// - The depth says which files are drawn: every one at Files depth, the core view's at Core depth
//   (no tests), none at Components depth, where the hubs grow, are always labelled, and are
//   joined by the imports between their groups, added up. Hubs are drawn at every depth, and
//   libraries while Libraries is on.
// - The lens colours and sizes the files, and labels its top files besides the selection.
// - A selection the map draws keeps its node and its neighbours bright and dims every other
//   node: the files and libraries an import joins to a file or a definition's file, the files
//   that import a library, or the files of a hub's group, with, at Components depth, the hubs an
//   import joins to it. Only the selection's curves are drawn; at Components depth, the curves
//   between the hubs it keeps bright.
// - The filters dim the files they leave out, as well, and move or hide nothing: no node, no
//   hub, no library and no curve. The selection's own node never dims.
// - Under History, a selected file's neighbours also include the files that change together
//   with it, each joined to it by a dashed curve. A map that does not carry co-change has them
//   from the outline cache, fetched once per file; the map refreshes when they arrive.
// - After each refresh, #map carries data-nodes (the visible nodes), data-dimmed (the visible
//   nodes drawn dimmed), data-hubs, data-curves (the import curves drawn) and data-cochange (the
//   co-change curves drawn).
// - A pointer over a node marks #map with the class "pointing".
// - After the first frame, the page records the performance mark hakutaku:first-map and sets
//   html[data-ready] to "map".
// graphology's declarations read as CommonJS, where its default export is the module itself, so
// the graph class comes by name.
import { DirectedGraph } from "graphology";
import Sigma from "sigma";
import type { Settings } from "sigma/settings";
import type { NodeDisplayData } from "sigma/types";
import { F, FILE_KINDS } from "../../../query/view/constants.js";
import {
  PULL_ACROSS,
  PULL_AGGREGATE,
  PULL_COCHANGE,
  PULL_WITHIN,
  R,
} from "../constants.js";
import { coreView, fileShownAt } from "../depth.js";
import { prefersReducedMotion } from "../dom.js";
import { passes } from "../filters.js";
import { groupKey, type Model } from "../model.js";
import { motionMs } from "../motion.js";
import type { OutlineCache } from "../outline-cache.js";
import type { Filters, Sel, StateStore, ViewState } from "../state.js";
import {
  CURVE_INK,
  fileColor,
  fileSize,
  INK,
  labelledFiles,
} from "./colors.js";
import {
  aggregateCurves,
  type CurveKind,
  type CurvePick,
  controlPoint,
  pickCurves,
} from "./curves.js";
import { type GalaxyLayout, galaxyLayout } from "./layout.js";

export interface MapView {
  refresh(): void; // re-reads the state: what is visible, the labels and the curves
  relayout(): void; // lays the galaxy out again for the state's grouping, then refreshes
  focus(sel: Sel, fly: boolean): void; // brings the selected node to the middle
  fit(): void; // shows the whole map
  zoom(step: 1 | -1): void; // zooms in one step, or out
}

type NodeKind = "file" | "test" | "hub" | "lib";
type NodeAttrs = {
  x: number;
  y: number;
  size: number;
  color: string;
  kind: NodeKind;
  index: number;
  name: string; // what its label and its hover tag say
};

const CODE = FILE_KINDS.indexOf("code");
const CAMERA_BOX = R + 380; // the camera frames ±this in graph units: every ring and its labels
const MAX_PIXEL_RATIO = 2;
const FLY_MS = 380;
const FIT_MS = 320;
const ZOOM_MS = 220;
const FOCUS_RATIO = 0.45; // the camera ratio a focused node is shown at, or closer
const ZOOM_FACTOR = 1.5; // one zoom step
const BIG_HUBS = 14; // hubs as large as the 14th largest are always labelled
const BUSY_LIBRARY = 6; // a library imported by at least this many files is always labelled
const HUB_GROWTH = 2.2; // how much larger hubs are drawn at Components depth, where they stand alone

// How each kind of import curve is stroked, in CSS pixels; drawn in this order.
const STROKES = [
  ["base", 0.6, CURVE_INK.base, []],
  ["selected", 1.1, CURVE_INK.selected, []],
  ["cycle", 1.6, CURVE_INK.cycle, []],
  ["cochange", 1.2, CURVE_INK.cochange, [4, 4]],
] as const satisfies ReadonlyArray<
  readonly [CurveKind, number, string, readonly number[]]
>;

// Whether this browser gives a canvas a WebGL context, asked the way sigma asks for one. A
// context made here is released at once.
function hasWebGL(): boolean {
  for (const kind of ["webgl2", "webgl", "experimental-webgl"]) {
    try {
      const gl = document
        .createElement("canvas")
        .getContext(kind) as WebGLRenderingContext | null;
      if (gl !== null) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return true;
      }
    } catch {
      // this browser does not know the kind; try the next
    }
  }
  return false;
}

// The hover and selection tag: the node's name in ivory on a dark tag, and an orange ring.
const drawHover: Settings<NodeAttrs>["defaultDrawNodeHover"] = (
  ctx,
  data,
  settings,
) => {
  const size = settings.labelSize;
  const name = typeof data.name === "string" ? data.name : (data.label ?? "");
  ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  if (name !== "") {
    const w = ctx.measureText(name).width + 12;
    const h = size + 9;
    const x = data.x + data.size + 5;
    const y = data.y - h / 2;
    ctx.fillStyle = INK.tag;
    ctx.strokeStyle = INK.tagLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 3);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK.hi;
    ctx.fillText(name, x + 6, data.y + size / 3);
  }
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  ctx.strokeStyle = INK.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Mounts the map in root, which holds #sigma and canvas#edges. Null when this browser cannot
// draw it: it has no WebGL, or sigma could not start. Without outlines, History joins no file
// to the files that change with it.
export function mountMap(
  root: HTMLElement,
  model: Model,
  state: StateStore,
  on: { node(sel: Sel): void; stage(): void },
  outlines?: OutlineCache,
): MapView | null {
  const container = root.querySelector<HTMLElement>("#sigma");
  const canvas = root.querySelector<HTMLCanvasElement>("#edges");
  const ctx = canvas?.getContext("2d") ?? null;
  if (container === null || canvas === null || ctx === null || !hasWebGL()) {
    return null;
  }

  const files = model.map.files;
  const n = files.length;
  let s: ViewState = state.get();
  let layout: GalaxyLayout = galaxyLayout(model, s.group);
  let hubIndex = new Map<string, number>(); // a hub's index by its key
  let groupIds = new Map<string, number>(); // a group's number by its key
  let groupOf = new Int32Array(n); // each file's group, by number; -1 off the map
  let always = new Set<string>(); // hubs and libraries always labelled
  let labelled: ReadonlySet<string> = new Set<string>(); // files labelled for the lens
  let selected: string | null = null; // the selection's node
  let lit: Set<string> | null = null; // the nodes a drawn selection keeps bright
  let picks: CurvePick[] = [];
  let shapes = new Map<CurveKind, Float64Array>(); // per kind: a, control point and b, per curve
  let aggregates: Array<{ shape: Float64Array; weight: number; hot: boolean }> =
    [];
  let joins: CurvePick[] | null = null; // the imports between hubs, added up, for the layout
  let filtered: Filters | null = null; // the filters leftOut was worked out for
  let leftOut: ReadonlySet<string> = new Set<string>(); // the files the filters leave out, by key
  const core = coreView(model);

  // Whether a file is drawn: its depth draws it, and its toggle, Code files or Tests, is on.
  const fileShows = (f: number): boolean =>
    fileShownAt(model, s.depth, f) &&
    (files[f][F.kind] === CODE ? s.show.production : s.show.tests);
  // Whether a node is drawn: a file as fileShows says, a hub always, a library while Libraries
  // is on.
  const shows = (kind: NodeKind, index: number): boolean =>
    kind === "file" || kind === "test"
      ? fileShows(index)
      : kind === "hub" || s.show.libraries;
  const hubJoins = (): CurvePick[] => {
    joins ??= aggregateCurves(model, s.group, (key) => hubIndex.get(key) ?? -1);
    return joins;
  };

  const graph = new DirectedGraph<NodeAttrs>();
  const build = () => {
    graph.clear();
    joins = null;
    hubIndex = new Map(layout.hubs.map((hub, i) => [hub.key, i]));
    const groups = new Map<string, number>();
    groupIds = groups;
    groupOf = new Int32Array(n).fill(-1);
    for (const f of [...model.production, ...model.tests]) {
      const key = groupKey(model, f, s.group);
      let id = groups.get(key);
      if (id === undefined) {
        id = groups.size;
        groups.set(key, id);
      }
      groupOf[f] = id;
    }
    const at = (f: number) => ({
      x: layout.pos[2 * f],
      y: layout.pos[2 * f + 1],
    });
    for (const f of model.production) {
      graph.addNode(`f${f}`, {
        ...at(f),
        size: 1,
        color: INK.lo,
        kind: "file",
        index: f,
        name: baseName(files[f][F.path]),
      });
    }
    for (const f of model.tests) {
      graph.addNode(`f${f}`, {
        ...at(f),
        size: 1,
        color: INK.faint,
        kind: "test",
        index: f,
        name: baseName(files[f][F.path]),
      });
    }
    const most = layout.hubs.reduce((m, hub) => Math.max(m, hub.files), 0);
    const cut =
      layout.hubs[Math.min(BIG_HUBS, layout.hubs.length) - 1]?.files ?? 0;
    always = new Set();
    layout.hubs.forEach((hub, i) => {
      graph.addNode(`h${i}`, {
        x: hub.x,
        y: hub.y,
        size: 3.5 + 6 * Math.sqrt(hub.files / most),
        color: INK.hub,
        kind: "hub",
        index: i,
        name: hub.key,
      });
      if (hub.files >= cut) always.add(`h${i}`);
    });
    const externals = model.map.externals;
    const busiest = externals.reduce((m, [, , uses]) => Math.max(m, uses), 0);
    externals.forEach(([, name, uses], e) => {
      const share = busiest > 0 ? uses / busiest : 0;
      graph.addNode(`x${e}`, {
        x: layout.libs[2 * e],
        y: layout.libs[2 * e + 1],
        size: 3 + 5 * Math.sqrt(share),
        color: INK.lib,
        kind: "lib",
        index: e,
        name,
      });
      if (uses >= BUSY_LIBRARY) always.add(`x${e}`);
    });
  };
  build();

  // Whether a drawn node is drawn dimmed: a selection keeps it no brighter than the rest, or it is
  // a file the filters leave out. The selection's own node never dims.
  const dims = (key: string): boolean =>
    key !== selected && ((lit !== null && !lit.has(key)) || leftOut.has(key));

  const reducer = (key: string, a: NodeAttrs): Partial<NodeDisplayData> => {
    if (!shows(a.kind, a.index)) return { ...a, hidden: true };
    const out: Partial<NodeDisplayData> & NodeAttrs = {
      ...a,
      hidden: false,
      zIndex: 1,
      label: "",
      forceLabel: false,
    };
    if (a.kind === "file" || a.kind === "test") {
      out.color = fileColor(model, a.index, s.lens, s.entriesOn);
      out.size = fileSize(model, a.index, s.lens);
      if (labelled.has(key)) {
        out.label = a.name;
        out.forceLabel = true;
      }
    } else if (a.kind === "hub" && s.depth === "components") {
      out.label = a.name;
      out.forceLabel = true;
      out.size = a.size * HUB_GROWTH;
    } else {
      out.label = a.name;
      out.forceLabel = always.has(key);
    }
    if (key === selected) {
      Object.assign(out, {
        highlighted: true,
        zIndex: 2,
        color: INK.accent,
        label: a.name,
        forceLabel: true,
      });
    } else if (dims(key)) {
      Object.assign(out, {
        zIndex: 0,
        color: INK.dim,
        label: "",
        forceLabel: false,
      });
    }
    return out;
  };

  let renderer: Sigma<NodeAttrs>;
  try {
    renderer = new Sigma(graph, container, {
      nodeReducer: reducer,
      zIndex: true,
      defaultDrawNodeHover: drawHover,
      labelFont: "IBM Plex Mono",
      labelSize: 11,
      labelWeight: "400",
      labelColor: { color: INK.label },
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.35,
      labelGridCellSize: 140,
      minCameraRatio: 0.04,
      maxCameraRatio: 4,
      stagePadding: 24,
      // a map area of no size, such as one hidden for a moment, draws at 1 pixel, not throws
      allowInvalidContainer: true,
    });
  } catch (e) {
    console.error("hakutaku: the map could not be drawn", e);
    container.replaceChildren();
    return null;
  }
  renderer.setCustomBBox({
    x: [-CAMERA_BOX, CAMERA_BOX],
    y: [-CAMERA_BOX, CAMERA_BOX],
  });

  // The selection's node, if the map draws one.
  const nodeOf = (sel: Sel): string | null => {
    if (sel === null) return null;
    let key: string | null = null;
    if (sel.kind === "file" || sel.kind === "definition") key = `f${sel.file}`;
    else if (sel.kind === "library") key = `x${sel.external}`;
    else {
      const hubKey =
        sel.kind === "group"
          ? sel.key
          : s.group === "component"
            ? model.map.components[sel.component]?.[0]
            : undefined;
      const i = hubKey === undefined ? undefined : hubIndex.get(hubKey);
      key = i === undefined ? null : `h${i}`;
    }
    return key !== null && graph.hasNode(key) ? key : null;
  };

  // What a click on a node selects.
  const selOf = (key: string): Sel => {
    const i = Number(key.slice(1));
    if (key.startsWith("f")) return { kind: "file", file: i };
    if (key.startsWith("x")) return { kind: "library", external: i };
    const hubKey = layout.hubs[i].key;
    const c =
      s.group === "component"
        ? model.map.components.findIndex(([path]) => path === hubKey)
        : -1;
    return c >= 0
      ? { kind: "component", component: c }
      : { kind: "group", key: hubKey };
  };

  // A file's selection, or a definition's: its file. Null for anything else.
  const fileOf = (sel: Sel): number | null =>
    sel !== null && (sel.kind === "file" || sel.kind === "definition")
      ? sel.file
      : null;

  // The files that change together with a file, as far as they are known: from the map, or from
  // an outline the cache holds. When a file's are not known, they are asked for, once at a time,
  // and the map refreshes when they arrive if that file is still selected under History; an
  // outline the cache has since dropped is asked for again. A request that failed, as one
  // answered by another build does, is not made again.
  const asking = new Set<number>();
  const failed = new Set<number>();
  const partnersOf = (file: number): number[] => {
    if (outlines === undefined) return [];
    const outline = outlines.peek(file);
    if (outline !== null) return outline.cochange.map(([partner]) => partner);
    if (!asking.has(file) && !failed.has(file)) {
      asking.add(file);
      outlines.get(file).then(
        () => {
          asking.delete(file);
          const now = state.get();
          if (now.lens === "history" && fileOf(now.sel) === file) refresh();
        },
        (e) => {
          asking.delete(file);
          failed.add(file);
          console.error(
            "hakutaku: the files that change with a file could not be loaded",
            e,
          );
        },
      );
    }
    return [];
  };

  // The files each lens labels, worked out once per lens and entry points.
  const labels = new Map<string, Set<string>>();
  const labelsFor = (view: ViewState): Set<string> => {
    const key = `${view.lens} ${view.entriesOn}`;
    let set = labels.get(key);
    if (set === undefined) {
      const top = labelledFiles(model, view.lens, view.entriesOn);
      set = new Set(top.map((f) => `f${f}`));
      labels.set(key, set);
    }
    return set;
  };

  // The nodes a selection keeps bright: its node, and the files and libraries an import joins to
  // a file (or a definition's file), with, under History, the files that change together with
  // it; the files that import a library; or the files of a hub's group, with, at Components
  // depth, the hubs an import joins to it. Null, so that nothing is dimmed, when nothing is
  // selected or its node is not drawn.
  const litBy = (sel: Sel, key: string | null): Set<string> | null => {
    if (sel === null || key === null) return null;
    const node = graph.getNodeAttributes(key);
    if (!shows(node.kind, node.index)) return null;
    const keep = new Set<string>([key]);
    const add = (prefix: "f" | "x", list: readonly number[]) => {
      for (const i of list) keep.add(`${prefix}${i}`);
    };
    if (sel.kind === "file" || sel.kind === "definition") {
      add("f", model.importers[sel.file]);
      add("f", model.imports[sel.file]);
      add("x", model.libsOf[sel.file]);
      if (s.lens === "history") add("f", partnersOf(sel.file));
    } else if (sel.kind === "library") {
      add("f", model.importersOfLib[sel.external]);
    } else {
      const hub = node.index;
      const group = groupIds.get(layout.hubs[hub].key);
      for (let f = 0; f < n; f++) if (groupOf[f] === group) keep.add(`f${f}`);
      if (s.depth === "components") {
        for (const c of hubJoins()) {
          if (c.from === hub) keep.add(`h${c.to}`);
          else if (c.to === hub) keep.add(`h${c.from}`);
        }
      }
    }
    return keep;
  };

  const pick = (): CurvePick[] => {
    if (!s.show.curves) return [];
    // between hubs; with a selection, only between the hubs it keeps bright
    if (s.depth === "components") {
      const all = hubJoins();
      const bright = lit;
      return bright === null
        ? all
        : all.filter((c) => bright.has(`h${c.from}`) && bright.has(`h${c.to}`));
    }
    const sel = s.sel;
    // a library's curves come from the files that import it; a hub has none of its own here
    if (sel?.kind === "library") {
      if (!s.show.libraries) return [];
      return model.importersOfLib[sel.external].filter(fileShows).map(
        (f): CurvePick => ({
          from: f,
          to: n + sel.external,
          kind: "selected",
          weight: 1,
        }),
      );
    }
    if (sel?.kind === "component" || sel?.kind === "group") return [];
    // under History, a dashed curve from the selected file to each file that changes with it
    const file = fileOf(sel);
    const cochange =
      file !== null && s.lens === "history"
        ? partnersOf(file).map((p): [number, number] => [file, p])
        : [];
    return pickCurves(model, {
      visible: fileShows,
      inCore: (f) => core.has(f),
      selected: file,
      riskLens: s.lens === "risk",
      cochange,
    }).filter((c) => c.to < n || s.show.libraries);
  };

  // Each curve's start, control point and end, in graph units.
  const shape = () => {
    const per = new Map<CurveKind, number[]>();
    aggregates = [];
    const hotHub = selected?.startsWith("h") ? Number(selected.slice(1)) : -1;
    for (const c of picks) {
      if (c.kind === "aggregate") {
        const [a, b] = [layout.hubs[c.from], layout.hubs[c.to]];
        const g = Float64Array.of(
          a.x,
          a.y,
          ...controlPoint(a.x, a.y, b.x, b.y, PULL_AGGREGATE),
          b.x,
          b.y,
        );
        aggregates.push({
          shape: g,
          weight: c.weight,
          hot: c.from === hotHub || c.to === hotHub,
        });
        continue;
      }
      const [ax, ay] = [layout.pos[2 * c.from], layout.pos[2 * c.from + 1]];
      const library = c.to >= n;
      const [bx, by] = library
        ? [layout.libs[2 * (c.to - n)], layout.libs[2 * (c.to - n) + 1]]
        : [layout.pos[2 * c.to], layout.pos[2 * c.to + 1]];
      const pull =
        c.kind === "cochange"
          ? PULL_COCHANGE
          : !library && groupOf[c.from] === groupOf[c.to]
            ? PULL_WITHIN
            : PULL_ACROSS;
      const list = per.get(c.kind) ?? [];
      per.set(c.kind, list);
      list.push(ax, ay, ...controlPoint(ax, ay, bx, by, pull), bx, by);
    }
    shapes = new Map(
      [...per].map(([kind, list]) => [kind, Float64Array.from(list)]),
    );
  };

  // After each of sigma's frames: the curves, through the frame's graph-to-viewport mapping.
  // That mapping is affine, so three points fix it, and each curve costs a few multiplications.
  let first = true;
  const drawCurves = () => {
    const { width, height } = renderer.getDimensions();
    const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    const [w, h] = [Math.round(width * ratio), Math.round(height * ratio)];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const o = renderer.graphToViewport({ x: 0, y: 0 });
    const ex = renderer.graphToViewport({ x: 1, y: 0 });
    const ey = renderer.graphToViewport({ x: 0, y: 1 });
    const [xx, xy, yx, yy] = [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y];
    const trace = (g: Float64Array) => {
      for (let i = 0; i < g.length; i += 6) {
        ctx.moveTo(
          o.x + xx * g[i] + yx * g[i + 1],
          o.y + xy * g[i] + yy * g[i + 1],
        );
        ctx.quadraticCurveTo(
          o.x + xx * g[i + 2] + yx * g[i + 3],
          o.y + xy * g[i + 2] + yy * g[i + 3],
          o.x + xx * g[i + 4] + yx * g[i + 5],
          o.y + xy * g[i + 4] + yy * g[i + 5],
        );
      }
    };
    const stroke = (width: number, color: string, dash: readonly number[]) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.setLineDash([...dash]);
      ctx.stroke();
    };
    STROKES.forEach(([kind, width, color, dash], i) => {
      const g = shapes.get(kind);
      if (g !== undefined) {
        ctx.beginPath();
        trace(g);
        stroke(width, color, dash);
      }
      if (i === 0) {
        // between hubs: thicker for more imports, and orange when one end is selected
        for (const a of aggregates) {
          ctx.beginPath();
          trace(a.shape);
          const width = 0.5 + Math.log2(1 + a.weight) * (a.hot ? 1 : 0.7);
          stroke(width, a.hot ? CURVE_INK.hubsSelected : CURVE_INK.hubs, []);
        }
      }
    });
    if (first) {
      first = false;
      performance.mark("hakutaku:first-map");
      document.documentElement.dataset.ready = "map";
    }
  };

  // The nodes drawn, and of those the ones drawn dimmed, read from the reducer's own output, so
  // that the counts are what sigma draws: a node the reducer hides is not counted, and a node it
  // dims, the only one it draws at zIndex 0, counts once, whatever dimmed it.
  const count = () => {
    const hubs = layout.hubs.length;
    const cochange = picks.filter((c) => c.kind === "cochange").length;
    let visible = 0;
    let dimmed = 0;
    graph.forEachNode((key, node) => {
      const drawn = reducer(key, node);
      if (drawn.hidden) return;
      visible++;
      if (drawn.zIndex === 0) dimmed++;
    });
    root.dataset.nodes = String(visible);
    root.dataset.dimmed = String(dimmed);
    root.dataset.hubs = String(hubs);
    root.dataset.curves = String(picks.length - cochange);
    root.dataset.cochange = String(cochange);
  };

  // The files the filters leave out, by node key, so that no hub or library is ever among them;
  // worked out again only when the filters change.
  const filter = (f: Filters) => {
    if (f === filtered) return;
    filtered = f;
    const out = new Set<string>();
    for (const file of [...model.production, ...model.tests]) {
      if (!passes(model, file, f)) out.add(`f${file}`);
    }
    leftOut = out;
  };

  const refresh = () => {
    s = state.get();
    filter(s.filters);
    selected = nodeOf(s.sel);
    lit = litBy(s.sel, selected);
    labelled = labelsFor(s);
    picks = pick();
    shape();
    count();
    renderer.refresh();
  };
  const relayout = () => {
    s = state.get();
    layout = galaxyLayout(model, s.group);
    build();
    refresh();
  };

  renderer.on("afterRender", drawCurves);
  renderer.on("clickNode", ({ node }) => on.node(selOf(node)));
  renderer.on("clickStage", () => on.stage());
  renderer.on("enterNode", () => root.classList.add("pointing"));
  renderer.on("leaveNode", () => root.classList.remove("pointing"));
  state.subscribe((now, before) => {
    if (now.group !== before.group) relayout();
    else refresh();
  });
  new ResizeObserver(() => renderer.scheduleRender()).observe(container);
  refresh();

  // Moves the camera, animated unless the viewer asks for reduced motion. A move without
  // animation sets the state at once: sigma's animation of 0 ms divides 0 by 0 on its first step.
  const camera = renderer.getCamera();
  const move = (
    target: { x?: number; y?: number; ratio: number; angle?: number },
    ms: number,
  ) => {
    const duration = motionMs(ms, prefersReducedMotion());
    if (duration > 0) void camera.animate(target, { duration });
    else camera.setState(target);
  };
  return {
    refresh,
    relayout,
    focus(sel, fly) {
      const key = nodeOf(sel);
      const d = key === null ? undefined : renderer.getNodeDisplayData(key);
      if (d === undefined || d.hidden) return;
      move(
        { x: d.x, y: d.y, ratio: Math.min(camera.ratio, FOCUS_RATIO) },
        fly ? FLY_MS : 0,
      );
    },
    fit() {
      move({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, FIT_MS);
    },
    zoom(step) {
      move(
        {
          ratio:
            step === 1
              ? camera.ratio / ZOOM_FACTOR
              : camera.ratio * ZOOM_FACTOR,
        },
        ZOOM_MS,
      );
    },
  };
}
