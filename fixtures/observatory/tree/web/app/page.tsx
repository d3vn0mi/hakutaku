"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatMagnitude } from "@obs/web/format/angles";
import { loadPlugins } from "@obs/web/plugins/loader";
import { browserCanvas, type Context2D } from "@obs/web/sky/browser-canvas";
import { Camera } from "@obs/web/sky/camera";
import { Catalog } from "@obs/web/sky/catalog";
import { drawFrame } from "@obs/web/sky/frame";
import { aboveHorizon } from "@obs/web/sky/horizon";
import { legendFor } from "@obs/web/sky/legend";
import { PLANETS } from "@obs/web/sky/planets";
import { daysSinceJ2000, julianDay } from "@obs/web/time/julian";

const PLUGINS = [{ dir: "/plugins/aurora", entry: "./index.js" }];
const OBSERVER = { latitude: 51.5, longitude: -0.13 };
const SATURN_ORBIT_AU = 10.1;
const PAGE = 12;

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [count, setCount] = useState(PAGE);
  const [plugins, setPlugins] = useState<string[]>([]);
  const catalog = useMemo(() => new Catalog(), []);
  const stars = catalog.brightest(count);
  const up = aboveHorizon(stars, OBSERVER, julianDay(new Date()));
  const legend = legendFor(PLANETS.map((planet) => planet.name));

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d") as Context2D | null | undefined;
    if (!ctx) return;
    const camera = new Camera(ctx.canvas.width, ctx.canvas.height);
    camera.frame(SATURN_ORBIT_AU);
    drawFrame(browserCanvas(ctx), PLANETS, daysSinceJ2000(new Date()), camera.zoom);
  }, []);

  useEffect(() => {
    loadPlugins(PLUGINS, (message) => console.warn(message)).then(setPlugins);
  }, []);

  return (
    <main>
      <h1>Tonight's sky</h1>
      <canvas ref={canvasRef} width={800} height={600} />
      <ul>
        {legend.map((entry) => (
          <li key={entry.label} style={{ color: entry.color }}>
            {entry.label}
          </li>
        ))}
      </ul>
      <h2>Bright stars above the horizon</h2>
      <ol>
        {up.map((star) => (
          <li key={star.name}>
            {star.name} <small>{formatMagnitude(star.magnitude)}</small>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => setCount(count + PAGE)}>
        Show more
      </button>
      {plugins.length > 0 && <p>Layers: {plugins.join(", ")}</p>}
    </main>
  );
}
