// The map: sigma draws the files, hubs and libraries with WebGL over a graphology graph, and the
// import curves are drawn on the canvas beneath it after each of sigma's frames. The curves are
// picked when the view state changes; a frame only redraws them.
// - Node keys: f<file index>, h<hub index>, x<library index>.
// - After each refresh, #map carries data-nodes (the visible nodes), data-dimmed (the visible
//   nodes drawn dimmed; this map dims none), data-hubs, data-curves (the import curves drawn)
//   and data-cochange (the co-change curves drawn).
// - After the first frame, the page records the performance mark hakutaku:first-map and sets
//   html[data-ready] to "map".
// graphology's declarations read as CommonJS, where its default export is the module itself, so
// the graph class comes by name.
import { DirectedGraph } from "graphology";
import Sigma from "sigma";
import type { Settings } from "sigma/settings";
import type { NodeDisplayData } from "sigma/types";
import { F, FILE_KINDS, FLAG_CORE } from "../../../query/view/constants.js";
import {
  LABEL_TOP,
  PULL_ACROSS,
  PULL_AGGREGATE,
  PULL_COCHANGE,
  PULL_WITHIN,
  R,
} from "../constants.js";
import { prefersReducedMotion } from "../dom.js";
import { groupKey, type Model } from "../model.js";
import type { Sel, StateStore, ViewState } from "../state.js";
import { fileColor, fileSize, INK } from "./colors.js";
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

// How each kind of import curve is stroked, in CSS pixels; drawn in this order.
const STROKES = [
  ["base", 0.6, "rgba(234, 228, 214, 0.055)", []],
  ["selected", 1.1, "rgba(234, 228, 214, 0.55)", []],
  ["cycle", 1.6, "rgba(232, 97, 60, 0.9)", []],
  ["cochange", 1.2, "rgba(232, 97, 60, 0.85)", [4, 4]],
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
    ctx.fillStyle = "#25211B";
    ctx.strokeStyle = "#3A332B";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 3);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#EAE4D6";
    ctx.fillText(name, x + 6, data.y + size / 3);
  }
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  ctx.strokeStyle = "#E8613C";
  ctx.lineWidth = 1.5;
  ctx.stroke();
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Mounts the map in root, which holds #sigma and canvas#edges. Null when this browser cannot
// draw it: it has no WebGL, or sigma could not start.
export function mountMap(
  root: HTMLElement,
  model: Model,
  state: StateStore,
  on: { node(sel: Sel): void; stage(): void },
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
  let groupOf = new Int32Array(n); // each file's group, by number; -1 off the map
  let always = new Set<string>(); // hubs and libraries always labelled
  let labelled = new Set<string>(); // files labelled for the lens
  let selected: string | null = null; // the selection's node
  let picks: CurvePick[] = [];
  let shapes = new Map<CurveKind, Float64Array>(); // per kind: a, control point and b, per curve
  let aggregates: Array<{ shape: Float64Array; weight: number; hot: boolean }> =
    [];

  const shows = (kind: NodeKind): boolean =>
    kind === "file"
      ? s.show.production && s.depth === "files"
      : kind === "test"
        ? s.show.tests && s.depth === "files"
        : kind === "hub" || s.show.libraries;
  const fileShows = (f: number): boolean =>
    model.onMap(f) && shows(files[f][F.kind] === CODE ? "file" : "test");

  const graph = new DirectedGraph<NodeAttrs>();
  const build = () => {
    graph.clear();
    hubIndex = new Map(layout.hubs.map((hub, i) => [hub.key, i]));
    const groups = new Map<string, number>();
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

  const reducer = (key: string, a: NodeAttrs): Partial<NodeDisplayData> => {
    if (!shows(a.kind)) return { ...a, hidden: true };
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
      labelColor: { color: "#CFC6B4" },
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

  const pick = (): CurvePick[] => {
    if (!s.show.curves) return [];
    if (s.depth === "components") {
      return aggregateCurves(model, s.group, (key) => hubIndex.get(key) ?? -1);
    }
    const sel = s.sel;
    return pickCurves(model, {
      visible: fileShows,
      inCore: (f) => (files[f][F.flags] & FLAG_CORE) !== 0,
      selected:
        sel !== null && (sel.kind === "file" || sel.kind === "definition")
          ? sel.file
          : null,
      riskLens: s.lens === "risk",
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
          stroke(
            width,
            a.hot ? "rgba(232, 97, 60, 0.8)" : "rgba(234, 228, 214, 0.16)",
            [],
          );
        }
      }
    });
    if (first) {
      first = false;
      performance.mark("hakutaku:first-map");
      document.documentElement.dataset.ready = "map";
    }
  };

  const count = () => {
    const shown = (kind: NodeKind, of: number) => (shows(kind) ? of : 0);
    const hubs = layout.hubs.length;
    const cochange = picks.filter((c) => c.kind === "cochange").length;
    root.dataset.nodes = String(
      shown("file", model.production.length) +
        shown("test", model.tests.length) +
        hubs +
        shown("lib", model.map.externals.length),
    );
    root.dataset.dimmed = "0";
    root.dataset.hubs = String(hubs);
    root.dataset.curves = String(picks.length - cochange);
    root.dataset.cochange = String(cochange);
  };

  const refresh = () => {
    s = state.get();
    selected = nodeOf(s.sel);
    labelled = new Set(
      model.production.slice(0, LABEL_TOP).map((f) => `f${f}`),
    );
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
    if (ms > 0 && !prefersReducedMotion())
      void camera.animate(target, { duration: ms });
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
