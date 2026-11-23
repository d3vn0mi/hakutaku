// The panels along the bottom: Core, the files the rest of the code depends on most; Hotspots,
// the files depended on that also change often; and the change activity, one bar per week for
// the last 26 weeks, the latest in the accent.

import { F } from "../../../query/view/constants.js";
import type { HistoryData } from "../../../query/view/types.js";
import { BOTTOM_TOP } from "../constants.js";
import { changesText, importersText } from "../detail/facts.js";
import { h } from "../dom.js";
import { byRank, type Model } from "../model.js";
import { count } from "../words.js";

// The chart's size in its own units; its width follows the element's.
const WIDTH = 600;
const HEIGHT = 100;
const BASE = HEIGHT - 16; // the line the bars stand on
const TALLEST = BASE - 12;

// Core: the top production files by rank, each with its importers. Hotspots: the top files by
// hotspot, each with its changes in the last 90 days; a file that never changed is none. Each
// row's name is a button that selects its file; its count says one in the singular.
export function fillRankLists(
  core: HTMLElement,
  hot: HTMLElement,
  model: Model,
  pick: (file: number) => void,
): void {
  const files = model.map.files;
  const row = (f: number, value: string) =>
    h(
      "li",
      {},
      h("button", {
        class: "name",
        text: files[f][F.path],
        attrs: { type: "button", title: files[f][F.path] },
        on: { click: () => pick(f) },
      }),
      h("span", { class: "v", text: value }),
    );
  core.replaceChildren(
    ...model.production
      .slice(0, BOTTOM_TOP)
      .map((f) => row(f, importersText(model, f))),
  );
  const hotspots = model.production
    .filter((f) => files[f][F.hotspot] > 0)
    .sort(
      (a, b) =>
        files[b][F.hotspot] - files[a][F.hotspot] || byRank(model, a, b),
    )
    .slice(0, BOTTOM_TOP);
  hot.replaceChildren(...hotspots.map((f) => row(f, changesText(model, f))));
}

// The change activity, into the page's own svg element: its namespace is the one every element
// drawn here takes. Each week's commits, and the peak, count one commit in the singular.
export function drawTimeline(svg: SVGSVGElement, history: HistoryData): void {
  const make = (
    tag: string,
    attrs: Record<string, string | number>,
    text?: string,
  ): Element => {
    const el = document.createElementNS(svg.namespaceURI, tag);
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, String(value));
    }
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const weeks = history.weeks;
  const width = svg.clientWidth || WIDTH;
  const step = (width - 8) / Math.max(1, weeks.length);
  const peak = weeks.reduce((most, w) => Math.max(most, w.commits), 0);
  const parts = [
    make("line", { class: "base", x1: 0, x2: width, y1: BASE, y2: BASE }),
  ];
  weeks.forEach((week, i) => {
    const tall = Math.max(1, TALLEST * (week.commits / (peak || 1)));
    const x = 4 + i * step;
    const day = new Date(week.start * 1000).toISOString().slice(0, 10);
    const bar = make("rect", {
      class: i === weeks.length - 1 ? "bar now" : "bar",
      x: x + 1,
      y: BASE - tall,
      width: Math.max(2, step - 3),
      height: tall,
      rx: 1,
    });
    bar.append(
      make("title", {}, `${count(week.commits, "commit")}, week of ${day}`),
    );
    parts.push(bar);
    if (i % 4 === 0) {
      parts.push(
        make("text", { class: "tick", x: x + 1, y: HEIGHT - 3 }, day.slice(5)),
      );
    }
  });
  parts.push(
    make(
      "text",
      { class: "peak", x: width - 4, y: 11, "text-anchor": "end" },
      `peak ${count(peak, "commit")}/week`,
    ),
  );
  svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
  svg.replaceChildren(...parts);
}
