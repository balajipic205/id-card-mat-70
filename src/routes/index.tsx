import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { IDCard } from "@/components/IDCard";
import { LayoutConfig, loadLayout, saveLayout, INITIAL_LAYOUT } from "@/lib/idcard-store";
import { Member, supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast, Toaster } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Editor — Makeathon 7.0 ID Card Studio" },
      {
        name: "description",
        content:
          "Adjust the placement of photo, QR and name on the Makeathon 7.0 participant ID card template.",
      },
    ],
  }),
  component: EditorPage,
});

const CARD_WIDTH = 360;

function NumberSlider({
  label,
  value,
  min,
  max,
  step = 0.5,
  onChange,
  unit = "%",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground">
          {value.toFixed(1)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

function EditorPage() {
  const [layout, setLayout] = useState<LayoutConfig>(INITIAL_LAYOUT);
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);

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
        .order("created_at", { ascending: true })
        .limit(1);
      if (!cancelled) {
        if (error) toast.error("Failed to load preview member: " + error.message);
        setMember((data?.[0] as Member) ?? null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const person = useMemo(
    () => ({
      id: member?.unique_member_id ?? "PREVIEW-001",
      name: member?.full_name ?? "Preview Participant",
      photo: member?.photo_url ?? null,
    }),
    [member]
  );

  function update<K extends keyof LayoutConfig>(key: K, patch: Partial<LayoutConfig[K]>) {
    setLayout((l) => ({ ...l, [key]: { ...l[key], ...patch } }));
  }

  function handleSave() {
    saveLayout(layout);
    toast.success("Layout saved. It will be used in the print sheet.");
  }

  function handleReset() {
    setLayout(INITIAL_LAYOUT);
    toast("Layout reset to defaults.");
  }

  return (
    <div className="min-h-screen">
      <Header />
      <Toaster theme="dark" position="top-right" richColors />
      <main className="mx-auto grid max-w-7xl gap-8 px-6 py-10 lg:grid-cols-[420px_1fr]">
        {/* Controls */}
        <section className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Layout Editor</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Position the photo, QR code and name on the template. Settings are saved locally and
              applied when generating the print sheet.
            </p>
          </div>

          <Panel title="Photo">
            <NumberSlider label="X (center)" min={0} max={100} value={layout.photo.x} onChange={(v) => update("photo", { x: v })} />
            <NumberSlider label="Y (center)" min={0} max={100} value={layout.photo.y} onChange={(v) => update("photo", { y: v })} />
            <NumberSlider label="Width" min={5} max={100} value={layout.photo.w} onChange={(v) => update("photo", { w: v })} />
            <NumberSlider label="Height" min={5} max={100} value={layout.photo.h} onChange={(v) => update("photo", { h: v })} />
            <NumberSlider label="Corner radius" min={0} max={50} value={layout.photo.radius} onChange={(v) => update("photo", { radius: v })} />
          </Panel>

          <Panel title="QR Code">
            <NumberSlider label="X (center)" min={0} max={100} value={layout.qr.x} onChange={(v) => update("qr", { x: v })} />
            <NumberSlider label="Y (center)" min={0} max={100} value={layout.qr.y} onChange={(v) => update("qr", { y: v })} />
            <NumberSlider label="Width" min={3} max={50} value={layout.qr.w} onChange={(v) => update("qr", { w: v })} />
            <NumberSlider label="Height" min={3} max={50} value={layout.qr.h} onChange={(v) => update("qr", { h: v })} />
          </Panel>

          <Panel title="Name">
            <NumberSlider label="X (center)" min={0} max={100} value={layout.name.x} onChange={(v) => update("name", { x: v })} />
            <NumberSlider label="Y (top)" min={0} max={100} value={layout.name.y} onChange={(v) => update("name", { y: v })} />
            <NumberSlider label="Box width" min={10} max={100} value={layout.name.w} onChange={(v) => update("name", { w: v })} />
            <NumberSlider label="Font size" min={2} max={15} step={0.25} value={layout.name.fontSize} onChange={(v) => update("name", { fontSize: v })} unit="" />
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div>
                <Label className="text-xs text-muted-foreground">Color</Label>
                <Input type="color" value={layout.name.color} onChange={(e) => update("name", { color: e.target.value })} className="h-9 p-1" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Align</Label>
                <select
                  value={layout.name.align}
                  onChange={(e) => update("name", { align: e.target.value as any })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={layout.name.bold} onChange={(e) => update("name", { bold: e.target.checked })} />
              Bold
            </label>
          </Panel>

          <div className="flex gap-3">
            <Button onClick={handleSave} className="flex-1">Save layout</Button>
            <Button onClick={handleReset} variant="outline">Reset</Button>
          </div>
        </section>

        {/* Preview */}
        <section className="flex flex-col items-center">
          <div className="mb-4 text-sm text-muted-foreground">
            {loading ? "Loading preview member…" : `Preview: ${person.name} (${person.id})`}
          </div>
          <div className="rounded-xl border border-border bg-card p-6 shadow-2xl">
            <IDCard person={person} layout={layout} width={CARD_WIDTH} />
          </div>
          <p className="mt-4 max-w-md text-center text-xs text-muted-foreground">
            QR encodes the participant&apos;s <span className="font-mono">unique_member_id</span>. When
            you&apos;re happy, save the layout and head to <strong>Generate Sheet</strong>.
          </p>
        </section>
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
