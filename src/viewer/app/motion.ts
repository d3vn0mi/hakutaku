// How long a camera move lasts: no time at all when the viewer asks for reduced motion. The map
// reads that wish from dom.ts's prefersReducedMotion() and passes it in. No DOM here: Node tests
// import it.
export function motionMs(base: number, reduced: boolean): number {
  return reduced ? 0 : base;
}
