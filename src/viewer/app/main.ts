// The page's start: read the map from the page's data source, then name the repo and its build
// in the title and the brand. html[data-ready] says how far it got: "loading", then "data" once
// the map has arrived, or "error" with #fatal saying why.
import "./styles/app.css";
import type { MapData } from "../../query/view/types.js";
import { pickSource } from "./data.js";
import { ApiError } from "./data-types.js";

const SEP = " \u00b7 ";
const NOT_BUILT =
  "This repo has no map yet. Run: hakutaku map <path to the repo>";

function setReady(state: "loading" | "data" | "error"): void {
  document.documentElement.dataset.ready = state;
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

async function start(): Promise<void> {
  setReady("loading");
  let map: MapData;
  try {
    map = await pickSource(document, location).map();
  } catch (e) {
    console.error("hakutaku: the map could not be loaded", e);
    const fatal = document.getElementById("fatal");
    if (fatal !== null) {
      fatal.textContent = failure(e);
      fatal.hidden = false;
    }
    setReady("error");
    return;
  }
  document.title = `hakutaku${SEP}${map.repo}`;
  const brand = document.querySelector(".brand");
  if (brand !== null) brand.textContent = brandOf(map);
  setReady("data");
}

void start();
