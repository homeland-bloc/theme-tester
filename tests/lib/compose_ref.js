// Software reference of the canvas composition in index.html (composeVariant / baseOf), for node tests.
// Image: { w, h, px: Uint8Array RGBA }. plan: SensorUI.composePlan(...). Per plan entry the source is mirrored (flip) then rotated
// clockwise by `steps` quarter-turns about the source seam (sx, sy), and lands about the target seam (tx, ty); clipped to the target rect.
// Entries from the old plan carry no seams: both default to the image centre.
const crypto = require("crypto");

const synthImage = (tag, w, h, topRows = 0) => { // opaque art below `topRows` transparent rows; every pixel unique per (tag, x, y)
  const px = new Uint8Array(w * h * 4);
  for (let y = topRows; y < h; y++) for (let x = 0; x < w; x++) {
    const hsh = crypto.createHash("md5").update(`${tag}:${x}:${y}`).digest();
    const i = (y * w + x) * 4;
    px[i] = hsh[0]; px[i + 1] = hsh[1]; px[i + 2] = hsh[2]; px[i + 3] = 255;
  }
  return { w, h, px };
};

const render = (plan, images, W, H) => {
  const out = new Uint8Array(W * H * 4);
  for (const p of plan) {
    const src = images[p.sourceTileRef];
    const tx = p.tx ?? W / 2, ty = p.ty ?? H / 2, sx = p.sx ?? src.w / 2, sy = p.sy ?? src.h / 2;
    const k = ((p.steps % 4) + 4) % 4;
    for (let y = Math.floor(p.y); y < Math.ceil(p.y + p.h); y++) for (let x = Math.floor(p.x); x < Math.ceil(p.x + p.w); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      let dx = x + 0.5 - tx, dy = y + 0.5 - ty;
      for (let r = 0; r < k; r++) [dx, dy] = [dy, -dx]; // inverse of one clockwise quarter turn (y down)
      if (p.flip) dx = -dx;
      const u = Math.floor(dx + sx), v = Math.floor(dy + sy);
      if (u < 0 || v < 0 || u >= src.w || v >= src.h) continue;
      const a = (v * src.w + u) * 4, b = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) out[b + c] = src.px[a + c];
    }
  }
  return out;
};
const hash = px => crypto.createHash("sha1").update(px).digest("hex");
module.exports = { synthImage, render, hash };
