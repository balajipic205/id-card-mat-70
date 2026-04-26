import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { AuthGate } from "@/components/AuthGate";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useRoles } from "@/lib/use-roles";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/sessions")({
  head: () => ({
    meta: [
      { title: "Attendance Sessions — Make-A-Thon 7.0" },
      {
        name: "description",
        content: "Create and manage attendance sessions across event days.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <SessionsPage />
    </AuthGate>
  ),
});

interface SessionRow {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  created_at: string;
}

function SessionsPage() {
  const { user } = useAuth();
  const { isAdmin, loading } = useRoles();

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="grid place-items-center py-24 text-sm text-muted-foreground">
          Checking permissions…
        </div>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="mx-auto max-w-xl px-6 py-24 text-center">
          <h1 className="font-display text-3xl font-bold text-gradient-spider">
            Admins only
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Only admins can create or edit attendance sessions.
          </p>
          <div className="mt-6">
            <Link
              to="/"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Back to editor
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-right" richColors />
      <Header />
      <SessionsWorkspace adminUserId={user?.id ?? null} />
    </div>
  );
}

function toLocalInput(value: string | Date) {
  const d = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SessionsWorkspace({ adminUserId }: { adminUserId: string | null }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [name, setName] = useState("Day 1 — Morning");
  const [starts, setStarts] = useState(toLocalInput(new Date()));
  const [ends, setEnds] = useState(
    toLocalInput(new Date(Date.now() + 4 * 3600_000)),
  );
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase
      .from("attendance_sessions")
      .select("*")
      .order("starts_at", { ascending: false });
    if (error) toast.error(error.message);
    setRows((data as SessionRow[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function createSession() {
    if (!name.trim()) return toast.error("Name required");
    setBusy(true);
    const { error } = await supabase.from("attendance_sessions").insert({
      name: name.trim(),
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      notes: notes.trim() || null,
      created_by: adminUserId,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Session created");
    setName("");
    setNotes("");
    load();
  }

  async function updateRow(id: string, patch: Partial<SessionRow>) {
    const { error } = await supabase
      .from("attendance_sessions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Saved");
    load();
  }

  async function removeRow(id: string) {
    if (
      !confirm(
        "Delete this session? All attendance rows for it will be removed.",
      )
    )
      return;
    const { error } = await supabase
      .from("attendance_sessions")
      .delete()
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    load();
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header>
        <div className="text-xs uppercase tracking-widest text-m7-red">
          Admin
        </div>
        <h1 className="font-display text-3xl font-bold">
          Attendance <span className="text-gradient-spider">Sessions</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create one session per check-in window (e.g. Day 1 Breakfast, Day 2
          Lunch). Volunteers pick the active session before scanning. Edit
          freely at any time — sessions are not locked.
        </p>
        <div className="gradient-bar mt-3 w-24 animate-shimmer" />
      </header>

      <section className="rounded-2xl border border-border bg-card/80 p-6 shadow-glow-pink">
        <h2 className="font-display text-lg font-semibold">New session</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Day 1 — Morning"
            />
          </div>
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Auditorium A"
            />
          </div>
          <div className="space-y-2">
            <Label>Starts at</Label>
            <Input
              type="datetime-local"
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Ends at</Label>
            <Input
              type="datetime-local"
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-5">
          <Button
            disabled={busy}
            onClick={createSession}
            className="bg-gradient-spider text-primary-foreground shadow-glow-pink"
          >
            {busy ? "Creating…" : "Create session"}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">All sessions</h2>
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No sessions yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <SessionEditor
                key={r.id}
                row={r}
                onSave={(patch) => updateRow(r.id, patch)}
                onDelete={() => removeRow(r.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function SessionEditor({
  row,
  onSave,
  onDelete,
}: {
  row: SessionRow;
  onSave: (patch: Partial<SessionRow>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [starts, setStarts] = useState(toLocalInput(row.starts_at));
  const [ends, setEnds] = useState(toLocalInput(row.ends_at));
  const [notes, setNotes] = useState(row.notes ?? "");
  return (
    <li className="rounded-xl border border-border bg-card/60 p-4">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Starts</Label>
          <Input
            type="datetime-local"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Ends</Label>
          <Input
            type="datetime-local"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Created {new Date(row.created_at).toLocaleString()}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onDelete}>
            Delete
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSave({
                name: name.trim(),
                notes: notes.trim() || null,
                starts_at: new Date(starts).toISOString(),
                ends_at: new Date(ends).toISOString(),
              })
            }
            className="bg-gradient-spider text-primary-foreground"
          >
            Save
          </Button>
        </div>
      </div>
    </li>
  );
}
