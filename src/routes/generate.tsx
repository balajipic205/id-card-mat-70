import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { AuthGate } from "@/components/AuthGate";
import { IDCard, TEMPLATE_RATIO } from "@/components/IDCard";
import { LayoutConfig, INITIAL_LAYOUT, loadLayout } from "@/lib/idcard-store";
import { Member, supabase, fetchPhotoAsDataUrl } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Toaster, toast } from "sonner";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export const Route = createFileRoute("/generate")({
  head: () => ({
    meta: [
      { title: "Generate Print Sheet — Makeathon 7.0 ID Card Studio" },
      {
        name: "description",
        content:
          "Generate a print-ready A4 PDF of Makeathon 7.0 participant ID cards (75x90mm each).",
      },
    ],
  }),
  component: GeneratePage,
});

interface Person {
  id: string;
  name: string;
  photo: string | null;
}

const EXAMPLE_JSON = JSON.stringify(
  [
    { id: "hw1041", name: "Buvanesh Raaj B Y", photo: "824d52bc-462c-4cb8-8434-79e0029a5ad0" },
    { id: "hw1042", name: "Aadhithya R", photo: null },
  ],
  null,
  2
);

// 75x90mm card. 2 cols x 3 rows = 6 cards per portrait A4 (fits cleanly).
const A4_W = 210;
const A4_H = 297;
const CARD_W_MM = 75;
const CARD_H_MM = 90;
const COLS = 2;
const ROWS = 3;
const PER_PAGE = COLS * ROWS;
const MARGIN_X = (A4_W - COLS * CARD_W_MM) / (COLS + 1);
const MARGIN_Y = (A4_H - ROWS * CARD_H_MM) / (ROWS + 1);

// Render at 300 DPI for print
const MM_PER_INCH = 25.4;
const DPI = 300;
const CARD_PX_W = Math.round((CARD_W_MM / MM_PER_INCH) * DPI);

// On-screen A4 preview pixel size (3.2 px / mm ≈ 672x950 — fits 959 viewport).
const PREVIEW_PX_PER_MM = 3.2;
const PREVIEW_W = A4_W * PREVIEW_PX_PER_MM;
const PREVIEW_H = A4_H * PREVIEW_PX_PER_MM;
const PREVIEW_CARD_W = CARD_W_MM * PREVIEW_PX_PER_MM;

function GeneratePage() {
  const [layout, setLayout] = useState<LayoutConfig>(INITIAL_LAYOUT);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jsonText, setJsonText] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLayout(loadLayout());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("members")
        .select("id, unique_member_id, full_name, photo_url")
        .order("created_at", { ascending: true });
      if (!cancelled) {
        if (error) toast.error("Failed to load members: " + error.message);
        setMembers((data as Member[]) ?? []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const peopleFromSelection: Person[] = useMemo(
    () =>
      members
        .filter((m) => selected.has(m.id))
        .map((m) => ({ id: m.unique_member_id, name: m.full_name, photo: m.photo_url })),
    [members, selected]
  );

  const peopleFromJson: Person[] = useMemo(() => {
    if (!jsonText.trim()) return [];
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x: any) => x && (x.id || x.unique_member_id) && (x.name || x.full_name))
        .map((x: any) => ({
          id: String(x.id ?? x.unique_member_id),
          name: String(x.name ?? x.full_name),
          photo: x.photo ?? x.photo_url ?? null,
        }));
    } catch {
      return [];
    }
  }, [jsonText]);

  const finalPeople = useMemo(
    () => [...peopleFromSelection, ...peopleFromJson],
    [peopleFromSelection, peopleFromJson]
  );

  const pages = useMemo(() => {
    const out: Person[][] = [];
    for (let i = 0; i < finalPeople.length; i += PER_PAGE) {
      out.push(finalPeople.slice(i, i + PER_PAGE));
    }
    return out;
  }, [finalPeople]);

  // Reset page index when content changes
  useEffect(() => {
    if (pageIndex >= pages.length) setPageIndex(0);
  }, [pages.length, pageIndex]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function selectAll() {
    setSelected(new Set(members.map((m) => m.id)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  async function generatePdf() {
    if (finalPeople.length === 0) {
      toast.error("Add at least one participant.");
      return;
    }
    setGenerating(true);
    try {
      // Pre-fetch all photo data URLs so html2canvas doesn't taint the canvas.
      toast.message("Preparing photos…");
      await Promise.all(finalPeople.map((p) => fetchPhotoAsDataUrl(p.photo)));
      // Wait for the export DOM to settle (images use the same cache).
      await new Promise((r) => setTimeout(r, 300));

      const container = exportRef.current;
      if (!container) throw new Error("Export container missing");

      const imgs = Array.from(container.querySelectorAll("img"));
      await Promise.all(
        imgs.map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete && img.naturalWidth > 0) resolve();
              else {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }
            })
        )
      );

      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const pageEls = Array.from(container.querySelectorAll<HTMLDivElement>("[data-page]"));

      for (let i = 0; i < pageEls.length; i++) {
        const canvas = await html2canvas(pageEls[i], {
          backgroundColor: "#ffffff",
          scale: 2,
          useCORS: true,
          allowTaint: false,
          logging: false,
          onclone: (doc) => {
            // html2canvas cannot parse oklch(). Strip any computed/declared
            // oklch colors from the cloned tree so it falls back to defaults.
            const all = doc.querySelectorAll<HTMLElement>("*");
            all.forEach((el) => {
              const s = el.style;
              (["color", "backgroundColor", "borderColor", "outlineColor", "fill", "stroke"] as const).forEach(
                (prop) => {
                  const v = (s as any)[prop] as string | undefined;
                  if (v && v.includes("oklch")) (s as any)[prop] = "";
                }
              );
            });
            // Also wipe any inherited oklch from html/body via inline overrides.
            const root = doc.documentElement;
            const body = doc.body;
            [root, body].forEach((el) => {
              if (!el) return;
              el.style.color = "#000000";
              el.style.background = "#ffffff";
            });
          },
        });
        const imgData = canvas.toDataURL("image/jpeg", 0.92);
        if (i > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(imgData, "JPEG", 0, 0, A4_W, A4_H);
      }
      pdf.save(`makeathon-id-cards-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success(`Generated ${pageEls.length} page(s) with ${finalPeople.length} card(s).`);
    } catch (err: any) {
      console.error(err);
      toast.error("PDF generation failed: " + err.message);
    } finally {
      setGenerating(false);
    }
  }

  const currentPage = pages[pageIndex] ?? [];

  return (
    <AuthGate>
      <div className="min-h-screen">
        <Header />
        <Toaster theme="dark" position="top-right" richColors />
        <main className="mx-auto max-w-7xl px-6 py-10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Generate Print Sheet</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Pick participants and/or paste JSON, then download a print-ready A4 PDF. Each card is
              exactly <strong>75 × 90 mm</strong>; 6 cards fit per A4 page (2 × 3) with breathing
              gaps. Extra participants flow onto more pages.
            </p>
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            {/* Members from DB */}
            <section className="rounded-lg border border-border bg-card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  From database ({members.length})
                </h2>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={selectAll}>All</Button>
                  <Button size="sm" variant="outline" onClick={clearAll}>None</Button>
                </div>
              </div>
              <div className="max-h-[420px] overflow-auto rounded-md border border-border">
                {loading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
                ) : members.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No members found.</div>
                ) : (
                  <ul className="divide-y divide-border">
                    {members.map((m) => (
                      <li key={m.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          onChange={() => toggle(m.id)}
                          className="h-4 w-4 accent-primary"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{m.full_name}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {m.unique_member_id}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {selected.size} selected from database.
              </div>
            </section>

            {/* JSON entry */}
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Bulk JSON entry
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Paste an array of objects. Required: <code>id</code> &amp; <code>name</code>. Optional:{" "}
                <code>photo</code> (storage path or full URL).
              </p>
              <Textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder={EXAMPLE_JSON}
                className="h-[280px] font-mono text-xs"
              />
              <div className="mt-2 flex items-center justify-between">
                <Button size="sm" variant="outline" onClick={() => setJsonText(EXAMPLE_JSON)}>
                  Load example
                </Button>
                <span className="text-xs text-muted-foreground">{peopleFromJson.length} parsed</span>
              </div>
            </section>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-5">
            <div>
              <div className="text-sm font-semibold">Total: {finalPeople.length} card(s)</div>
              <div className="text-xs text-muted-foreground">
                {Math.max(1, pages.length)} A4 page(s) at 75 × 90 mm
              </div>
            </div>
            <Button onClick={generatePdf} disabled={generating || finalPeople.length === 0} size="lg">
              {generating ? "Generating…" : "Download PDF"}
            </Button>
          </div>

          {/* A4 preview with paginator */}
          {pages.length > 0 && (
            <section className="mt-10">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  A4 Preview
                </h3>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                    disabled={pageIndex === 0}
                  >
                    ← Prev
                  </Button>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    Page {pageIndex + 1} / {pages.length}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
                    disabled={pageIndex >= pages.length - 1}
                  >
                    Next →
                  </Button>
                </div>
              </div>
              <div className="flex justify-center overflow-auto rounded-lg border border-border bg-muted/30 p-6">
                <div
                  style={{
                    width: `${PREVIEW_W}px`,
                    height: `${PREVIEW_H}px`,
                    background: "#ffffff",
                    padding: `${MARGIN_Y * PREVIEW_PX_PER_MM}px ${MARGIN_X * PREVIEW_PX_PER_MM}px`,
                    display: "grid",
                    gridTemplateColumns: `repeat(${COLS}, ${PREVIEW_CARD_W}px)`,
                    gridTemplateRows: `repeat(${ROWS}, ${CARD_H_MM * PREVIEW_PX_PER_MM}px)`,
                    gap: `${MARGIN_Y * PREVIEW_PX_PER_MM}px ${MARGIN_X * PREVIEW_PX_PER_MM}px`,
                    boxSizing: "border-box",
                    boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
                  }}
                >
                  {currentPage.map((p, idx) => (
                    <div
                      key={idx}
                      style={{
                        width: `${PREVIEW_CARD_W}px`,
                        height: `${CARD_H_MM * PREVIEW_PX_PER_MM}px`,
                        overflow: "hidden",
                      }}
                    >
                      <IDCard person={p} layout={layout} width={PREVIEW_CARD_W} />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
        </main>

        {/* Off-screen export DOM at exact print resolution */}
        <div
          ref={exportRef}
          style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none" }}
        >
          {pages.map((page, pi) => (
            <div
              key={pi}
              data-page={pi}
              style={{
                width: `${A4_W}mm`,
                height: `${A4_H}mm`,
                padding: `${MARGIN_Y}mm ${MARGIN_X}mm`,
                background: "#ffffff",
                display: "grid",
                gridTemplateColumns: `repeat(${COLS}, ${CARD_W_MM}mm)`,
                gridTemplateRows: `repeat(${ROWS}, ${CARD_H_MM}mm)`,
                gap: `${MARGIN_Y}mm ${MARGIN_X}mm`,
                boxSizing: "border-box",
              }}
            >
              {page.map((p, idx) => (
                <div
                  key={idx}
                  style={{ width: `${CARD_W_MM}mm`, height: `${CARD_H_MM}mm`, overflow: "hidden" }}
                >
                  <IDCard person={p} layout={layout} width={CARD_PX_W} embedPhoto />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </AuthGate>
  );
}
