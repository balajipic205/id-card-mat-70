// Persist layout positions of photo, qr, name on the template (in % of template dims).
export interface LayoutConfig {
  photo: { x: number; y: number; w: number; h: number; radius: number };
  qr: { x: number; y: number; w: number; h: number };
  name: { x: number; y: number; w: number; fontSize: number; color: string; align: "left" | "center" | "right"; bold: boolean };
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  photo: { x: 28, y: 33, w: 44, h: 35, radius: 4 },
  qr: { x: 70, y: 78, w: 22, h: 18, /* placeholder */ } as any,
  name: { x: 50, y: 72, w: 80, fontSize: 7, color: "#ffffff", align: "center", bold: true },
};

// Better defaults based on the template (square placeholder in middle, "PARTICIPANT" at bottom).
export const INITIAL_LAYOUT: LayoutConfig = {
  photo: { x: 50, y: 47, w: 45, h: 38, radius: 2 },
  qr: { x: 82, y: 90, w: 14, h: 11 },
  name: { x: 50, y: 72, w: 90, fontSize: 6, color: "#ffffff", align: "center", bold: true },
};

const KEY = "makeathon_idcard_layout_v1";

export function loadLayout(): LayoutConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return INITIAL_LAYOUT;
    return { ...INITIAL_LAYOUT, ...JSON.parse(raw) };
  } catch {
    return INITIAL_LAYOUT;
  }
}

export function saveLayout(layout: LayoutConfig) {
  localStorage.setItem(KEY, JSON.stringify(layout));
}
