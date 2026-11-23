// The map's layout constants and the viewer's thresholds. No DOM here: Node tests import it.

// The galaxy, in graph units: the radius of the disc of production files, the twist that turns
// the disc's outer files further round, and the rings outside it for tests, hubs and libraries.
export const R = 640;
export const TWIST = 0.85;
export const TEST_RING = 46;
export const TEST_SPREAD = 70;
export const HUB_RING = 175;
export const LIB_RING = 330;

// A curve's control point is its midpoint scaled toward the centre by one of these: a small
// factor bends the curve through the middle, so imports between groups bundle there, while an
// import within a group keeps most of its midpoint and stays close to a straight line.
export const PULL_WITHIN = 0.78;
export const PULL_ACROSS = 0.22;
export const PULL_AGGREGATE = 0.2;
export const PULL_COCHANGE = 0.5;

export const CURVE_BUDGET = 15000; // the most curves drawn in one frame
export const LABEL_TOP = 8; // files labelled for the lens, besides the selection
export const HOTSPOT_MARK = 0.35; // a hotspot above this is marked
export const CORE_DEPTH_ABOVE = 400; // production files above which the map opens at Core depth
export const BOTTOM_TOP = 5; // rows in the Core and Hotspots lists
export const OUTLINE_CACHE_LIMIT = 256; // outlines the page holds, besides the ones it shows

export const WORKER_HIGHLIGHT_ABOVE = 2500; // lines above which a file is highlighted in a worker
export const SOURCE_CHUNK_LINES = 500; // lines highlighted at a time
export const FIND_MAX = 14; // results Find shows
export const LIST_PAGE = 200; // files the list view shows at a time
