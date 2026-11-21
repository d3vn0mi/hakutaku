// From the plane of the solar system to the screen: a centre, a scale and a rotation.
export interface Viewport {
  width: number;
  height: number;
  scale: number; // pixels per astronomical unit
  rotation: number; // radians, counter-clockwise
  center: [number, number];
}

// A viewport that shows the planets out to Jupiter's orbit, centred on the Sun.
export function defaultViewport(width: number, height: number): Viewport {
  return {
    width,
    height,
    scale: Math.min(width, height) / 12,
    rotation: 0,
    center: [0, 0],
  };
}

// A point in astronomical units, in pixels from the screen's top left corner.
export function project(point: [number, number], view: Viewport): [number, number] {
  const dx = point[0] - view.center[0];
  const dy = point[1] - view.center[1];
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  return [
    view.width / 2 + (dx * cos - dy * sin) * view.scale,
    view.height / 2 - (dx * sin + dy * cos) * view.scale,
  ];
}

// Whether a projected point falls on the screen.
export function onScreen([x, y]: [number, number], view: Viewport): boolean {
  return x >= 0 && y >= 0 && x <= view.width && y <= view.height;
}
