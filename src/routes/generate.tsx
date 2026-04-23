import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { IDCard, TEMPLATE_RATIO } from "@/components/IDCard";
import { LayoutConfig, INITIAL_LAYOUT, loadLayout } from "@/lib/idcard-store";
import { Member, supabase } from "@/lib/supabase";
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
          "Generate a print-ready A4 PDF of Makeathon 7.0 participant ID cards in a 3x3 layout (75x90mm each).",
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
    { id: "hw1043", name: "S Vikhashini", photo: null },
  ],
  null,
  2
);

// A4: 210 x 297 mm. Card: 75 x 90 mm. 3 cols x 3 rows = 225 x 270 mm content.
// Gutter: (210-225)? -> 225 > 210, so we need to revisit. Actually 75*3=225 > 210 -> impossible side-by-side.
// Recompute: 75mm width * 3 cols = 225mm > 210mm. Use 2 cols x 3 rows? User wanted 3x3 of 9.
// Use portrait 3x3 with 65mm width? But user said 75x90. Solution: rotate sheet to landscape A4 (297x210)
// Landscape: 297 wide -> 75*3=225 + 4 gutters of 18mm = wait: margins.
// Let's place 3x3 on landscape A4: width 297, height 210. 3 cards wide of 75mm = 225, leaving 72mm for 4 gaps -> 18mm gaps. Height: 3 cards of 90mm = 270 > 210. Doesn't fit either.
// 9 cards of 75x90 on a single A4 isn't physically possible. Use one A4 per row? Better: print 6 per A4 (2 cols x 3 rows = 150x270 mm portrait, fits).
// We'll do 2 cols x 3 rows per A4 page = 6 per page, multi-page if more. This avoids overlap and respects 75x90mm exactly.
const A4_W = 210;
const A4_H = 297;
const CARD_W_MM = 75;
const CARD_H_MM = 90;
const COLS = 2;
const ROWS = 3;
const PER_PAGE = COLS * ROWS;
const MARGIN_X = (A4_W - COLS * CARD_W_MM) / (COLS + 1); // gutters incl. edges
const MARGIN_Y = (A4_H - ROWS * CARD_H_MM) / (ROWS + 1);

// Render at 300 DPI for print
const MM_PER_INCH = 25.4;
const DPI = 300;
const CARD_PX_W = Math.round((CARD_W_MM / MM_PER_INCH) * DPI); // ~886
const CARD_PX_H = Math.round(CARD_PX_W * TEMPLATE_RATIO);

function GeneratePage() {
  const [layout, setLayout] = useState<LayoutConfig>(INITIAL_LAYOUT);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jsonText, setJsonText] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [exportPeople, setExportPeople] = useState<Person[] | null>(null);

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

  const filtered = members;

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

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectAll() {
    setSelected(new Set(filtered.map((m) => m.id)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  async function generatePdf() {
    if (finalPeople.length === 0) {
      toast.error("Add at least one participant (select members or paste JSON).");
      return;
    }
    setGenerating(true);
    setExportPeople(finalPeople);
    // Wait for DOM paint + images
    await new Promise((r) => setTimeout(r, 100));
    try {
      const container = exportRef.current;
      if (!container) throw new Error("Export container missing");
      // Wait for all images inside container to load
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
      setExportPeople(null);
    }
  }

  const pages = useMemo(() => {
    if (!exportPeople) return [];
    const out: Person[][] = [];
    for (let i = 0; i < exportPeople.length; i += PER_PAGE) {
      out.push(exportPeople.slice(i, i + PER_PAGE));
    }
    return out;
  }, [exportPeople]);

  return (
    <div className="min-h-screen">
      <Header />
      <Toaster theme="dark" position="top-right" richColors />
      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Generate Print Sheet</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Pick participants from your database and/or paste a JSON list, then export a print-ready
            A4 PDF. Each card is exactly <strong>75 × 90 mm</strong> with breathing room. Fits 6 cards
            per A4 sheet (2 × 3) with no overlaps; extra participants flow onto more pages.
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
              Paste an array of objects. Required fields: <code>id</code> &amp; <code>name</code>. Optional:{" "}
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
              {Math.max(1, Math.ceil(finalPeople.length / PER_PAGE))} A4 page(s) at 75 × 90 mm
            </div>
          </div>
          <Button onClick={generatePdf} disabled={generating || finalPeople.length === 0} size="lg">
            {generating ? "Generating…" : "Download PDF"}
          </Button>
        </div>

        {/* Live preview of first 3 */}
        {finalPeople.length > 0 && (
          <section className="mt-10">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Preview
            </h3>
            <div className="flex flex-wrap gap-4">
              {finalPeople.slice(0, 6).map((p, i) => (
                <IDCard key={i} person={p} layout={layout} width={200} />
              ))}
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
                <IDCard person={p} layout={layout} width={CARD_PX_W} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
