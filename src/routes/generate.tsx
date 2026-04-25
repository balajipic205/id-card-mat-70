import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { AuthGate } from "@/components/AuthGate";
import { IDCard, TEMPLATE_RATIO } from "@/components/IDCard";
import { LayoutConfig, INITIAL_LAYOUT, loadLayout } from "@/lib/idcard-store";
import {
  Member,
  Team,
  supabase,
  fetchStorageAsDataUrl,
  PAYMENT_BUCKET,
} from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Toaster, toast } from "sonner";
import jsPDF from "jspdf";
import { renderCardToDataUrl, prewarm } from "@/lib/render-card";


export const Route = createFileRoute("/generate")({
  head: () => ({
    meta: [
      { title: "Generate Print Sheet — Makeathon 7.0 ID Card Studio" },
      {
        name: "description",
        content:
          "Generate A4 or single-card PDFs for Makeathon 7.0 participant ID cards and bulk payment screenshot PDFs.",
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

type ExportMode = "sheet" | "single";

const EXAMPLE_JSON = JSON.stringify(
  [
    { id: "hw1041", name: "Buvanesh Raaj B Y", photo: "824d52bc-462c-4cb8-8434-79e0029a5ad0" },
    { id: "hw1042", name: "Aadhithya R", photo: null },
  ],
  null,
  2,
);

const A4_W = 210;
const A4_H = 297;
const CARD_W_MM = 75;
const CARD_H_MM = 90;
const CARD_RENDER_H_MM = CARD_W_MM * TEMPLATE_RATIO;
const COLS = 2;
const ROWS = 3;
const PER_PAGE = COLS * ROWS;
const MARGIN_X = (A4_W - COLS * CARD_W_MM) / (COLS + 1);
const MARGIN_Y = (A4_H - ROWS * CARD_H_MM) / (ROWS + 1);

const EXPORT_CARD_W_PX = 900;
const RENDER_CONCURRENCY = 6;

const PREVIEW_PX_PER_MM = 3.2;
const PREVIEW_W = A4_W * PREVIEW_PX_PER_MM;
const PREVIEW_H = A4_H * PREVIEW_PX_PER_MM;
const PREVIEW_CELL_W = CARD_W_MM * PREVIEW_PX_PER_MM;
const PREVIEW_CELL_H = CARD_H_MM * PREVIEW_PX_PER_MM;
const PREVIEW_CARD_W = PREVIEW_CELL_W;
const PREVIEW_CARD_H = PREVIEW_CARD_W * TEMPLATE_RATIO;

const BATCH_SIZE = 20;

function chunkPeople(people: Person[]) {
  const out: Person[][] = [];
  for (let i = 0; i < people.length; i += PER_PAGE) {
    out.push(people.slice(i, i + PER_PAGE));
  }
  return out;
}

async function loadImageElement(src: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image could not be loaded."));
    img.src = src;
  });
}

function getImageFormat(dataUrl: string): "PNG" | "JPEG" {
  return dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
}

function fitWithin(maxW: number, maxH: number, width: number, height: number) {
  const ratio = Math.min(maxW / width, maxH / height, 1);
  return { width: width * ratio, height: height * ratio };
}

function GeneratePage() {
  const [layout, setLayout] = useState<LayoutConfig>(INITIAL_LAYOUT);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jsonText, setJsonText] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [exportMode, setExportMode] = useState<ExportMode>("sheet");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Range selection (1-indexed, inclusive) over finalPeople.
  const [rangeFrom, setRangeFrom] = useState<string>("");
  const [rangeTo, setRangeTo] = useState<string>("");

  // Payment screenshots — bulk only, fully from database.
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [paymentGenerating, setPaymentGenerating] = useState(false);
  const [paymentProgress, setPaymentProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [paymentRangeFrom, setPaymentRangeFrom] = useState<string>("");
  const [paymentRangeTo, setPaymentRangeTo] = useState<string>("");

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTeamsLoading(true);
      const { data, error } = await supabase
        .from("teams")
        .select(
          "id, team_number, team_name, problem_statement_id, problem_statement_name, payment_screenshot_url, reference_id",
        )
        .order("team_number", { ascending: true });
      if (!cancelled) {
        if (error) toast.error("Failed to load teams: " + error.message);
        setTeams((data as Team[]) ?? []);
        setTeamsLoading(false);
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
    [members, selected],
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

  const allPeople = useMemo(
    () => [...peopleFromSelection, ...peopleFromJson],
    [peopleFromSelection, peopleFromJson],
  );

  // Apply range filter (1-indexed). Empty = full list.
  const finalPeople = useMemo(() => {
    const total = allPeople.length;
    const fromN = rangeFrom.trim() === "" ? 1 : Math.max(1, parseInt(rangeFrom, 10) || 1);
    const toN = rangeTo.trim() === "" ? total : Math.min(total, parseInt(rangeTo, 10) || total);
    if (fromN > toN) return [];
    return allPeople.slice(fromN - 1, toN);
  }, [allPeople, rangeFrom, rangeTo]);

  const sheetPages = useMemo(() => chunkPeople(finalPeople), [finalPeople]);
  const previewPageCount = exportMode === "sheet" ? sheetPages.length : finalPeople.length;

  useEffect(() => {
    if (pageIndex >= previewPageCount) setPageIndex(0);
  }, [pageIndex, previewPageCount]);

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

  function applyBatch(batchIdx: number) {
    const total = allPeople.length;
    const from = batchIdx * BATCH_SIZE + 1;
    const to = Math.min(total, (batchIdx + 1) * BATCH_SIZE);
    setRangeFrom(String(from));
    setRangeTo(String(to));
    setPageIndex(0);
  }

  const cardBatchCount = Math.max(1, Math.ceil(allPeople.length / BATCH_SIZE));

  async function renderCardImages(): Promise<string[]> {
    if (document.fonts?.ready) await document.fonts.ready;
    await prewarm(finalPeople);

    const total = finalPeople.length;
    setProgress({ done: 0, total });

    const out: string[] = new Array(total);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= total) return;
        const person = finalPeople[i];
        out[i] = await renderCardToDataUrl({
          person,
          layout,
          widthPx: EXPORT_CARD_W_PX,
        });
        completed += 1;
        if (completed % 5 === 0 || completed === total) {
          setProgress({ done: completed, total });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(RENDER_CONCURRENCY, total) },
      () => worker(),
    );
    await Promise.all(workers);
    return out;
  }

  async function generatePdf() {
    if (finalPeople.length === 0) {
      toast.error("Add at least one participant.");
      return;
    }

    setGenerating(true);
    try {
      toast.message("Preparing cards…");
      const cardImages = await renderCardImages();
      const filenameDate = new Date().toISOString().slice(0, 10);
      const rangeLabel =
        rangeFrom || rangeTo ? `-${rangeFrom || 1}-${rangeTo || allPeople.length}` : "";

      if (exportMode === "sheet") {
        const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
        cardImages.forEach((imgData, idx) => {
          if (idx > 0 && idx % PER_PAGE === 0) pdf.addPage("a4", "portrait");
          const slot = idx % PER_PAGE;
          const col = slot % COLS;
          const row = Math.floor(slot / COLS);
          const x = MARGIN_X + col * (CARD_W_MM + MARGIN_X);
          const yCell = MARGIN_Y + row * (CARD_H_MM + MARGIN_Y);
          const y = yCell + (CARD_H_MM - CARD_RENDER_H_MM) / 2;
          pdf.addImage(imgData, "JPEG", x, y, CARD_W_MM, CARD_RENDER_H_MM, undefined, "FAST");
        });
        pdf.save(`makeathon-id-cards-a4${rangeLabel}-${filenameDate}.pdf`);
        toast.success(`Generated ${Math.max(1, sheetPages.length)} A4 page(s).`);
      } else {
        const pdf = new jsPDF({
          unit: "mm",
          format: [CARD_W_MM, CARD_H_MM],
          orientation: "portrait",
        });
        cardImages.forEach((imgData, idx) => {
          if (idx > 0) pdf.addPage([CARD_W_MM, CARD_H_MM], "portrait");
          const y = (CARD_H_MM - CARD_RENDER_H_MM) / 2;
          pdf.addImage(imgData, "JPEG", 0, y, CARD_W_MM, CARD_RENDER_H_MM, undefined, "FAST");
        });
        pdf.save(`makeathon-id-cards-single${rangeLabel}-${filenameDate}.pdf`);
        toast.success(`Generated ${cardImages.length} single-card page(s).`);
      }
    } catch (err: any) {
      console.error(err);
      toast.error("PDF generation failed: " + err.message);
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  // ---------- Payment screenshots (bulk from DB) ----------

  const paymentBatchCount = Math.max(1, Math.ceil(teams.length / BATCH_SIZE));

  function applyPaymentBatch(batchIdx: number) {
    const total = teams.length;
    const from = batchIdx * BATCH_SIZE + 1;
    const to = Math.min(total, (batchIdx + 1) * BATCH_SIZE);
    setPaymentRangeFrom(String(from));
    setPaymentRangeTo(String(to));
  }

  const selectedTeams = useMemo(() => {
    const total = teams.length;
    const fromN =
      paymentRangeFrom.trim() === "" ? 1 : Math.max(1, parseInt(paymentRangeFrom, 10) || 1);
    const toN =
      paymentRangeTo.trim() === "" ? total : Math.min(total, parseInt(paymentRangeTo, 10) || total);
    if (fromN > toN) return [];
    return teams.slice(fromN - 1, toN);
  }, [teams, paymentRangeFrom, paymentRangeTo]);

  async function generateBulkPaymentPdf() {
    const targets = selectedTeams.filter((t) => t.payment_screenshot_url);
    const skipped = selectedTeams.length - targets.length;
    if (targets.length === 0) {
      toast.error("No teams with payment screenshots in the selected range.");
      return;
    }

    setPaymentGenerating(true);
    setPaymentProgress({ done: 0, total: targets.length });
    try {
      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const sidePad = 14;
      const contentW = pageW - sidePad * 2;

      let firstPage = true;
      let done = 0;

      for (const team of targets) {
        const dataUrl = await fetchStorageAsDataUrl(
          team.payment_screenshot_url!,
          PAYMENT_BUCKET,
        );
        if (!dataUrl) {
          done++;
          setPaymentProgress({ done, total: targets.length });
          continue;
        }

        if (!firstPage) pdf.addPage("a4", "portrait");
        firstPage = false;

        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageW, pageH, "F");

        let cursorY = 18;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(18);
        const teamLines = pdf.splitTextToSize(team.team_name ?? "Team", contentW);
        pdf.text(teamLines, sidePad, cursorY);
        cursorY += teamLines.length * 8;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(12);
        pdf.text(
          `Serial Number: ${team.team_number != null ? team.team_number : "—"}`,
          sidePad,
          cursorY,
        );
        cursorY += 7;
        pdf.text(`Problem Statement ID: ${team.problem_statement_id ?? "—"}`, sidePad, cursorY);
        cursorY += 8;

        try {
          const img = await loadImageElement(dataUrl);
          const fitted = fitWithin(contentW, pageH - cursorY - 14, img.width, img.height);
          const imageX = (pageW - fitted.width) / 2;
          pdf.addImage(
            dataUrl,
            getImageFormat(dataUrl),
            imageX,
            cursorY,
            fitted.width,
            fitted.height,
            undefined,
            "FAST",
          );
        } catch (e) {
          pdf.text("(Could not render screenshot)", sidePad, cursorY + 10);
        }

        done++;
        setPaymentProgress({ done, total: targets.length });
        await new Promise((r) => setTimeout(r, 0));
      }

      const rangeLabel = `${paymentRangeFrom || 1}-${paymentRangeTo || teams.length}`;
      pdf.save(`payment-screenshots-${rangeLabel}-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success(
        `Generated ${targets.length} page(s)${skipped ? ` (${skipped} skipped — no screenshot)` : ""}.`,
      );
    } catch (err: any) {
      console.error(err);
      toast.error("Bulk payment PDF failed: " + err.message);
    } finally {
      setPaymentGenerating(false);
      setPaymentProgress(null);
    }
  }

  const currentSheetPage = sheetPages[pageIndex] ?? [];
  const currentSinglePerson = finalPeople[pageIndex] ?? null;

  return (
    <AuthGate>
      <div className="min-h-screen">
        <Header />
        <Toaster theme="dark" position="top-right" richColors />
        <main className="mx-auto max-w-7xl px-6 py-10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Generate Print Sheet</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Pick participants and download either an <strong>A4 sheet</strong> or a{" "}
              <strong>single 75 × 90 mm card PDF</strong>. Use the range controls
              to download a slice (e.g. cards 1–20).
            </p>
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            <section className="rounded-lg border border-border bg-card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  From database ({members.length})
                </h2>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={selectAll}>
                    All
                  </Button>
                  <Button size="sm" variant="outline" onClick={clearAll}>
                    None
                  </Button>
                </div>
              </div>
              <div className="max-h-[420px] overflow-auto rounded-md border border-border">
                {loading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
                ) : members.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No members found.
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {members.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
                      >
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

            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Bulk JSON entry
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Paste an array of objects. Required: <code>id</code> and <code>name</code>.
                Optional:
                <code> photo</code>.
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
                <span className="text-xs text-muted-foreground">
                  {peopleFromJson.length} parsed
                </span>
              </div>
            </section>
          </div>

          {/* Range selector */}
          <div className="mt-6 rounded-lg border border-border bg-card p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Range ({allPeople.length} total)
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Download a specific slice. Leave both empty to include everyone.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: cardBatchCount }, (_, i) => {
                  const from = i * BATCH_SIZE + 1;
                  const to = Math.min(allPeople.length, (i + 1) * BATCH_SIZE);
                  return (
                    <Button
                      key={i}
                      size="sm"
                      variant="outline"
                      onClick={() => applyBatch(i)}
                      disabled={allPeople.length === 0}
                    >
                      {from}–{to}
                    </Button>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRangeFrom("");
                    setRangeTo("");
                    setPageIndex(0);
                  }}
                >
                  All
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">From</label>
              <Input
                type="number"
                min={1}
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                placeholder="1"
                className="w-28"
              />
              <label className="text-sm">To</label>
              <Input
                type="number"
                min={1}
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                placeholder={String(allPeople.length || 1)}
                className="w-28"
              />
              <span className="text-xs text-muted-foreground">
                Selected: {finalPeople.length} card(s)
              </span>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-5">
            <div className="space-y-1">
              <div className="text-sm font-semibold">Total: {finalPeople.length} card(s)</div>
              <div className="text-xs text-muted-foreground">
                {exportMode === "sheet"
                  ? `${Math.max(1, sheetPages.length)} A4 page(s), 6 cards per page`
                  : `${Math.max(1, finalPeople.length)} page(s), 1 card per 75 × 90 mm page`}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-muted-foreground">Output</label>
              <select
                value={exportMode}
                onChange={(e) => {
                  setExportMode(e.target.value as ExportMode);
                  setPageIndex(0);
                }}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                <option value="sheet">A4 sheet</option>
                <option value="single">75 × 90 mm single card</option>
              </select>
              <Button
                onClick={generatePdf}
                disabled={generating || finalPeople.length === 0}
                size="lg"
              >
                {generating
                  ? progress
                    ? `Rendering ${progress.done}/${progress.total}…`
                    : "Generating…"
                  : "Download PDF"}
              </Button>
            </div>
          </div>

          {previewPageCount > 0 && (
            <section className="mt-10">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  {exportMode === "sheet" ? "A4 Preview" : "75 × 90 mm Preview"}
                </h2>
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
                    Page {pageIndex + 1} / {previewPageCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPageIndex((i) => Math.min(previewPageCount - 1, i + 1))
                    }
                    disabled={pageIndex >= previewPageCount - 1}
                  >
                    Next →
                  </Button>
                </div>
              </div>

              <div className="flex justify-center overflow-auto rounded-lg border border-border bg-muted/30 p-6">
                {exportMode === "sheet" ? (
                  <div
                    style={{
                      width: `${PREVIEW_W}px`,
                      height: `${PREVIEW_H}px`,
                      background: "#ffffff",
                      padding: `${MARGIN_Y * PREVIEW_PX_PER_MM}px ${MARGIN_X * PREVIEW_PX_PER_MM}px`,
                      display: "grid",
                      gridTemplateColumns: `repeat(${COLS}, ${PREVIEW_CELL_W}px)`,
                      gridTemplateRows: `repeat(${ROWS}, ${PREVIEW_CELL_H}px)`,
                      gap: `${MARGIN_Y * PREVIEW_PX_PER_MM}px ${MARGIN_X * PREVIEW_PX_PER_MM}px`,
                      boxSizing: "border-box",
                      boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
                    }}
                  >
                    {currentSheetPage.map((p, idx) => (
                      <div
                        key={`${p.id}-${idx}`}
                        style={{
                          width: `${PREVIEW_CELL_W}px`,
                          height: `${PREVIEW_CELL_H}px`,
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <div
                          style={{
                            width: `${PREVIEW_CARD_W}px`,
                            height: `${PREVIEW_CARD_H}px`,
                          }}
                        >
                          <IDCard person={p} layout={layout} width={PREVIEW_CARD_W} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : currentSinglePerson ? (
                  <div
                    style={{
                      width: `${PREVIEW_CELL_W}px`,
                      height: `${PREVIEW_CELL_H}px`,
                      background: "#ffffff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
                    }}
                  >
                    <div
                      style={{ width: `${PREVIEW_CARD_W}px`, height: `${PREVIEW_CARD_H}px` }}
                    >
                      <IDCard
                        person={currentSinglePerson}
                        layout={layout}
                        width={PREVIEW_CARD_W}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {/* ============ Bulk payment screenshot section ============ */}
          <section className="mt-12 rounded-lg border border-border bg-card p-5">
            <div className="mb-5">
              <h2 className="text-2xl font-bold tracking-tight">Payment Screenshots (Bulk)</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Download payment screenshots for a range of teams as a single
                PDF (one team per page) — pulled directly from the database.
                Teams without an uploaded screenshot are skipped automatically.
              </p>
            </div>

            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                {teamsLoading ? (
                  <span className="text-muted-foreground">Loading teams…</span>
                ) : (
                  <>
                    <span className="font-semibold">{teams.length}</span> teams ·{" "}
                    <span className="font-semibold">
                      {teams.filter((t) => t.payment_screenshot_url).length}
                    </span>{" "}
                    with screenshots
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: paymentBatchCount }, (_, i) => {
                  const from = i * BATCH_SIZE + 1;
                  const to = Math.min(teams.length, (i + 1) * BATCH_SIZE);
                  return (
                    <Button
                      key={i}
                      size="sm"
                      variant="outline"
                      onClick={() => applyPaymentBatch(i)}
                      disabled={teams.length === 0}
                    >
                      {from}–{to}
                    </Button>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPaymentRangeFrom("");
                    setPaymentRangeTo("");
                  }}
                >
                  All
                </Button>
              </div>
            </div>

            <div className="mb-5 flex flex-wrap items-center gap-3">
              <label className="text-sm">From</label>
              <Input
                type="number"
                min={1}
                value={paymentRangeFrom}
                onChange={(e) => setPaymentRangeFrom(e.target.value)}
                placeholder="1"
                className="w-28"
              />
              <label className="text-sm">To</label>
              <Input
                type="number"
                min={1}
                value={paymentRangeTo}
                onChange={(e) => setPaymentRangeTo(e.target.value)}
                placeholder={String(teams.length || 1)}
                className="w-28"
              />
              <span className="text-xs text-muted-foreground">
                Selected: {selectedTeams.length} team(s) ·{" "}
                {selectedTeams.filter((t) => t.payment_screenshot_url).length} with screenshot
              </span>
              <div className="ml-auto">
                <Button
                  onClick={generateBulkPaymentPdf}
                  disabled={paymentGenerating || selectedTeams.length === 0}
                  size="lg"
                >
                  {paymentGenerating
                    ? paymentProgress
                      ? `Rendering ${paymentProgress.done}/${paymentProgress.total}…`
                      : "Generating…"
                    : "Download PDF"}
                </Button>
              </div>
            </div>

            <div className="max-h-[360px] overflow-auto rounded-md border border-border bg-background">
              {teamsLoading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
              ) : selectedTeams.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No teams in this range.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {selectedTeams.map((t, i) => {
                    const realIdx =
                      (paymentRangeFrom.trim() === ""
                        ? 0
                        : Math.max(0, parseInt(paymentRangeFrom, 10) - 1 || 0)) + i;
                    return (
                      <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-8 text-right font-mono text-xs text-muted-foreground">
                          {realIdx + 1}.
                        </span>
                        <span className="inline-flex h-5 min-w-[2rem] items-center justify-center rounded bg-primary/15 px-1.5 font-mono text-xs">
                          #{t.team_number ?? "?"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {t.team_name}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {t.problem_statement_id ?? "-"}
                        </span>
                        {t.payment_screenshot_url ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-500">
                            ok
                          </span>
                        ) : (
                          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-destructive">
                            no screenshot
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </main>
      </div>
    </AuthGate>
  );
}
