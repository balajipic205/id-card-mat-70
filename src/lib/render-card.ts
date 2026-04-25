// Direct canvas renderer for ID cards — orders of magnitude faster than
// html2canvas because we skip DOM rasterization entirely. We just paint the
// template image, photo (with rounded corners), QR code, and name text onto
// a 2D canvas. The output is identical in layout to <IDCard /> so the editor
// preview stays the source of truth.

import QRCode from "qrcode";
import templateImg from "@/assets/id-template.svg";
import { LayoutConfig } from "@/lib/idcard-store";
import { TEMPLATE_RATIO } from "@/components/IDCard";
import { fetchPhotoAsDataUrl } from "@/lib/supabase";

let templatePromise: Promise<HTMLImageElement> | null = null;
function loadTemplate(): Promise<HTMLImageElement> {
  if (!templatePromise) {
    templatePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      // Force a high intrinsic size so SVG rasterizes crisply on the canvas.
      img.width = 1200;
      img.height = Math.round(1200 * TEMPLATE_RATIO);
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load template image"));
      img.src = templateImg;
    });
  }
  return templatePromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

// QR cache — many cards reuse the same code patterns rarely, but we cache by id.
const qrCache = new Map<string, Promise<HTMLImageElement>>();
function getQrImage(id: string): Promise<HTMLImageElement> {
  const cached = qrCache.get(id);
  if (cached) return cached;
  const p = QRCode.toDataURL(id, {
    margin: 1,
    width: 400,
    color: { dark: "#000000", light: "#ffffff" },
  }).then(loadImage);
  qrCache.set(id, p);
  return p;
}


// Photo cache by storage path / URL.
const photoCache = new Map<string, Promise<HTMLImageElement | null>>();
function getPhotoImage(photo: string | null): Promise<HTMLImageElement | null> {
  if (!photo) return Promise.resolve(null);
  const cached = photoCache.get(photo);
  if (cached) return cached;
  const p: Promise<HTMLImageElement | null> = fetchPhotoAsDataUrl(photo).then(async (url: string | null) => {
    if (!url) return null;
    try {
      return await loadImage(url);
    } catch {
      return null;
    }
  });
  photoCache.set(photo, p);
  return p;
}


export interface RenderCardInput {
  person: { id: string; name: string; photo: string | null };
  layout: LayoutConfig;
  /** Output card width in pixels (height derived from TEMPLATE_RATIO). */
  widthPx: number;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rPct: number,
) {
  // rPct is layout.photo.radius (0–50ish, % of min(w,h)/2). Match the CSS
  // border-radius interpretation we used in <IDCard /> reasonably closely.
  const r = Math.min(w, h) * (rPct / 100);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  // object-fit: cover semantics
  const ir = img.naturalWidth / img.naturalHeight;
  const dr = dw / dh;
  let sx = 0,
    sy = 0,
    sw = img.naturalWidth,
    sh = img.naturalHeight;
  if (ir > dr) {
    // image wider — crop left/right
    sw = img.naturalHeight * dr;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / dr;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

export async function renderCardToDataUrl({
  person,
  layout,
  widthPx,
}: RenderCardInput): Promise<string> {
  const W = Math.round(widthPx);
  const H = Math.round(widthPx * TEMPLATE_RATIO);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // 1. Template background
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  const template = await loadTemplate();
  ctx.drawImage(template, 0, 0, W, H);

  // 2. Photo
  const photoX = ((layout.photo.x - layout.photo.w / 2) / 100) * W;
  const photoY = ((layout.photo.y - layout.photo.h / 2) / 100) * H;
  const photoW = (layout.photo.w / 100) * W;
  const photoH = (layout.photo.h / 100) * H;

  ctx.save();
  roundedRectPath(ctx, photoX, photoY, photoW, photoH, layout.photo.radius);
  ctx.clip();
  // Background tint behind photo (matches the card's rgba(0,0,0,0.2))
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(photoX, photoY, photoW, photoH);

  const [photo, qr] = await Promise.all([getPhotoImage(person.photo), getQrImage(person.id)]);
  if (photo) {
    drawCover(ctx, photo, photoX, photoY, photoW, photoH);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `${Math.round(W * 0.03)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No photo", photoX + photoW / 2, photoY + photoH / 2);
  }
  ctx.restore();

  // 3. QR (white background with small padding, then QR drawn inside)
  const qrX = ((layout.qr.x - layout.qr.w / 2) / 100) * W;
  const qrY = ((layout.qr.y - layout.qr.h / 2) / 100) * H;
  const qrW = (layout.qr.w / 100) * W;
  const qrH = (layout.qr.h / 100) * H;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(qrX, qrY, qrW, qrH);
  const pad = Math.max(1, Math.round(Math.min(qrW, qrH) * 0.02));
  // contain: square QR centered
  const inner = Math.min(qrW - pad * 2, qrH - pad * 2);
  const qrDx = qrX + (qrW - inner) / 2;
  const qrDy = qrY + (qrH - inner) / 2;
  ctx.drawImage(qr, qrDx, qrDy, inner, inner);

  // 4. Name
  const nameLeft = ((layout.name.x - layout.name.w / 2) / 100) * W;
  const nameTop = (layout.name.y / 100) * H;
  const nameWidth = (layout.name.w / 100) * W;
  const fontSizePx = (layout.name.fontSize / 100) * H;
  const weight = layout.name.bold ? 700 : 500;
  ctx.font = `${weight} ${fontSizePx}px Helvetica, Arial, sans-serif`;
  ctx.fillStyle = layout.name.color;
  ctx.textBaseline = "top";
  ctx.textAlign =
    layout.name.align === "left" ? "left" : layout.name.align === "right" ? "right" : "center";
  // soft shadow to mimic textShadow
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowOffsetY = 1;
  ctx.shadowBlur = 2;

  const tx =
    layout.name.align === "left"
      ? nameLeft
      : layout.name.align === "right"
        ? nameLeft + nameWidth
        : nameLeft + nameWidth / 2;
  ctx.fillText(person.name, tx, nameTop, nameWidth);
  ctx.shadowColor = "transparent";

  return canvas.toDataURL("image/jpeg", 0.92);
}

/** Pre-warm the template + photo + QR caches so the actual render loop is hot. */
export async function prewarm(people: { id: string; photo: string | null }[]) {
  await loadTemplate();
  // fan out, ignoring failures — they show as "No photo" in the card
  await Promise.allSettled([
    ...people.map((p) => getPhotoImage(p.photo)),
    ...people.map((p) => getQrImage(p.id)),
  ]);
}
