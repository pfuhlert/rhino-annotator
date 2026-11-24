// Trackpad pinches arrive as many ctrl+wheel events of a few pixels each, a mouse notch as one ~100px event.
// A steep rate keeps pinches responsive; the clamp keeps a mouse notch to about 1.25x.
export function wheelZoomFactor(deltaY: number, deltaMode: number) {
  const px = deltaMode ? deltaY * 40 : deltaY;
  return Math.exp(-Math.max(-15, Math.min(15, px)) * 0.015);
}

// A plain mouse notch zooms 1.2x, as in OpenSeadragon; a trackpad's small steps in proportion.
export function scrollZoomFactor(deltaY: number, deltaMode: number) {
  const px = deltaMode ? deltaY * 40 : deltaY;
  return 1.2 ** -Math.max(-1, Math.min(1, px / 100));
}
