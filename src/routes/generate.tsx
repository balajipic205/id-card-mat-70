import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Header } from "@/components/Header";
import { AuthGate } from "@/components/AuthGate";
import { IDCard, TEMPLATE_RATIO } from "@/components/IDCard";
import { LayoutConfig, INITIAL_LAYOUT, loadLayout } from "@/lib/idcard-store";
import { Member, supabase, fetchPhotoAsDataUrl } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
          "Generate A4 or single-card PDFs for Makeathon 7.0 participant ID cards and payment screenshot documents.",
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

const EXPORT_CARD_W_PX = 360;
const EXPORT_SCALE = 3.2;

const PREVIEW_PX_PER_MM = 3.2;
const PREVIEW_W = A4_W * PREVIEW_PX_PER_MM;
const PREVIEW_H = A4_H * PREVIEW_PX_PER_MM;
const PREVIEW_CELL_W = CARD_W_MM * PREVIEW_PX_PER_MM;
const PREVIEW_CELL_H = CARD_H_MM * PREVIEW_PX_PER_MM;
const PREVIEW_CARD_W = PREVIEW_CELL_W;
const PREVIEW_CARD_H = PREVIEW_CARD_W * TEMPLATE_RATIO;

const SANITIZED_EXPORT_STYLE = `
  :root, html, body, * {
    --background: #ffffff;
    --foreground: #000000;
    --card: #ffffff;
    --card-foreground: #000000;
    --popover: #ffffff;
    --popover-foreground: #000000;
    --primary: #000000;
    --primary-foreground: #ffffff;
    --secondary: #f1f5f9;
    --secondary-foreground: #000000;
    --muted: #f1f5f9;
    --muted-foreground: #475569;
    --accent: #f1f5f9;
    --accent-foreground: #000000;
    --destructive: #ef4444;
    --destructive-foreground: #ffffff;
    --border: #e2e8f0;
    --input: #e2e8f0;
    --ring: #000000;
  }
  html, body {
    color: #000 !important;
    background: #fff !important;
  }
`;

function sanitizeClonedDocument(doc: Document) {
  const style = doc.createElement("style");
  style.textContent = SANITIZED_EXPORT_STYLE;
  doc.head.appendChild(style);

  doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const inlineStyle = el.getAttribute("style");
    if (inlineStyle?.includes("oklch")) {
      el.setAttribute("style", inlineStyle.replace(/oklch\([^)]*\)/g, "#000"));
    }
  });
}

function chunkPeople(people: Person[]) {
  const out: Person[][] = [];
  for (let i = 0; i < people.length; i += PER_PAGE) {
    out.push(people.slice(i, i + PER_PAGE));
  }
  return out;
}

async function waitForImages(scope: ParentNode) {
  const images = Array.from(scope.querySelectorAll("img"));
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) {
            resolve();
            return;
          }
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
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
  const [paymentGenerating, setPaymentGenerating] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [exportMode, setExportMode] = useState<ExportMode>("sheet");
  const [teamName, setTeamName] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [problemStatementId, setProblemStatementId] = useState("");
  const [paymentScreenshot, setPaymentScreenshot] = useState<string | null>(null);
  const [paymentFilename, setPaymentFilename] = useState("");
  const cardExportRef = useRef<HTMLDivElement>(null);

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

  const finalPeople = useMemo(
    () => [...peopleFromSelection, ...peopleFromJson],
    [peopleFromSelection, peopleFromJson],
  );

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

  async function renderCardImages() {
    const container = cardExportRef.current;
    if (!container) throw new Error("Export cards are not ready yet.");

    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    await Promise.all(finalPeople.map((person) => fetchPhotoAsDataUrl(person.photo)));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForImages(container);

    const cardEls = Array.from(container.querySelectorAll<HTMLElement>("[data-export-card]"));
    if (cardEls.length === 0) throw new Error("No cards available for export.");

    const imageData: string[] = [];
    for (const cardEl of cardEls) {
      const canvas = await html2canvas(cardEl, {
        backgroundColor: "#ffffff",
        scale: EXPORT_SCALE,
        useCORS: true,
        allowTaint: false,
        logging: false,
        onclone: sanitizeClonedDocument,
      });
      imageData.push(canvas.toDataURL("image/jpeg", 0.95));
    }
    return imageData;
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
        pdf.save(`makeathon-id-cards-a4-${filenameDate}.pdf`);
        toast.success(`Generated ${Math.max(1, sheetPages.length)} A4 page(s).`);
      } else {
        const pdf = new jsPDF({ unit: "mm", format: [CARD_W_MM, CARD_H_MM], orientation: "portrait" });
        cardImages.forEach((imgData, idx) => {
          if (idx > 0) pdf.addPage([CARD_W_MM, CARD_H_MM], "portrait");
          const y = (CARD_H_MM - CARD_RENDER_H_MM) / 2;
          pdf.addImage(imgData, "JPEG", 0, y, CARD_W_MM, CARD_RENDER_H_MM, undefined, "FAST");
        });
        pdf.save(`makeathon-id-cards-single-${filenameDate}.pdf`);
        toast.success(`Generated ${cardImages.length} single-card page(s).`);
      }
    } catch (err: any) {
      console.error(err);
      toast.error("PDF generation failed: " + err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handlePaymentScreenshotChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setPaymentScreenshot(null);
      setPaymentFilename("");
      return;
    }

    setPaymentFilename(file.name);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Failed to read screenshot."));
      reader.readAsDataURL(file);
    });
    setPaymentScreenshot(dataUrl);
  }

  async function generatePaymentPdf() {
    if (!teamName.trim() || !serialNumber.trim() || !problemStatementId.trim() || !paymentScreenshot) {
      toast.error("Add the team name, serial number, problem statement ID and screenshot.");
      return;
    }

    setPaymentGenerating(true);
    try {
      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const sidePad = 14;
      const contentW = pageW - sidePad * 2;

      pdf.setFillColor(255, 255, 255);
      pdf.rect(0, 0, pageW, pageH, "F");

      let cursorY = 18;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      const teamLines = pdf.splitTextToSize(teamName.trim(), contentW);
      pdf.text(teamLines, sidePad, cursorY);
      cursorY += teamLines.length * 8;

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(12);
      pdf.text(`Serial Number: ${serialNumber.trim()}`, sidePad, cursorY);
      cursorY += 7;
      pdf.text(`Problem Statement ID: ${problemStatementId.trim()}`, sidePad, cursorY);
      cursorY += 8;

      const screenshotImage = await loadImageElement(paymentScreenshot);
      const fitted = fitWithin(contentW, pageH - cursorY - 14, screenshotImage.width, screenshotImage.height);
      const imageX = (pageW - fitted.width) / 2;
      pdf.addImage(
        paymentScreenshot,
        getImageFormat(paymentScreenshot),
        imageX,
        cursorY,
        fitted.width,
        fitted.height,
        undefined,
        "FAST",
      );

      const safeName = teamName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "team";
      pdf.save(`payment-screenshot-${safeName}.pdf`);
      toast.success("Payment screenshot PDF downloaded.");
    } catch (err: any) {
      console.error(err);
      toast.error("Payment PDF generation failed: " + err.message);
    } finally {
      setPaymentGenerating(false);
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
              Pick participants and download either an <strong>A4 sheet</strong> or a
              <strong> single 75 × 90 mm card PDF</strong>. The export now uses the same
              card rendering as the editor so the saved name alignment stays consistent.
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
              <div className="mt-2 text-xs text-muted-foreground">{selected.size} selected from database.</div>
            </section>

            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Bulk JSON entry
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Paste an array of objects. Required: <code>id</code> and <code>name</code>. Optional:
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
                <span className="text-xs text-muted-foreground">{peopleFromJson.length} parsed</span>
              </div>
            </section>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-5">
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
              <Button onClick={generatePdf} disabled={generating || finalPeople.length === 0} size="lg">
                {generating ? "Generating…" : "Download PDF"}
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
                    onClick={() => setPageIndex((i) => Math.min(previewPageCount - 1, i + 1))}
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
                        <div style={{ width: `${PREVIEW_CARD_W}px`, height: `${PREVIEW_CARD_H}px` }}>
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
                    <div style={{ width: `${PREVIEW_CARD_W}px`, height: `${PREVIEW_CARD_H}px` }}>
                      <IDCard person={currentSinglePerson} layout={layout} width={PREVIEW_CARD_W} />
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          <section className="mt-10 rounded-lg border border-border bg-card p-5">
            <div className="mb-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Payment screenshot PDF
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Upload the payment screenshot, then download a clean PDF with the team name,
                serial number, and problem statement ID placed above it.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium">Team name</label>
                  <Input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Sentinels" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium">Serial number</label>
                  <Input
                    value={serialNumber}
                    onChange={(e) => setSerialNumber(e.target.value)}
                    placeholder="SR-001"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium">Problem statement ID</label>
                  <Input
                    value={problemStatementId}
                    onChange={(e) => setProblemStatementId(e.target.value)}
                    placeholder="HW0108"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium">Payment screenshot</label>
                  <Input type="file" accept="image/png,image/jpeg,image/webp" onChange={handlePaymentScreenshotChange} />
                  <div className="mt-2 text-xs text-muted-foreground">
                    {paymentFilename || "Upload a screenshot file to include in the PDF."}
                  </div>
                </div>
                <Button onClick={generatePaymentPdf} disabled={paymentGenerating}>
                  {paymentGenerating ? "Generating…" : "Download payment PDF"}
                </Button>
              </div>

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Preview
                </div>
                <div className="rounded-md border border-border bg-background p-4">
                  <div className="border-b border-border pb-3">
                    <div className="text-lg font-semibold">{teamName || "Team name"}</div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      Serial Number: {serialNumber || "—"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Problem Statement ID: {problemStatementId || "—"}
                    </div>
                  </div>

                  <div className="mt-4 flex min-h-[360px] items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-4">
                    {paymentScreenshot ? (
                      <img
                        src={paymentScreenshot}
                        alt="Payment screenshot preview"
                        className="max-h-[520px] max-w-full rounded-md object-contain shadow-lg"
                      />
                    ) : (
                      <div className="text-sm text-muted-foreground">Payment screenshot preview will appear here.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <div
          ref={cardExportRef}
          aria-hidden="true"
          style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none", display: "grid", gap: 24 }}
        >
          {finalPeople.map((person, idx) => (
            <div key={`${person.id}-${idx}`} data-export-card={idx} style={{ width: `${EXPORT_CARD_W_PX}px` }}>
              <IDCard person={person} layout={layout} width={EXPORT_CARD_W_PX} embedPhoto />
            </div>
          ))}
        </div>
      </div>
    </AuthGate>
  );
}
