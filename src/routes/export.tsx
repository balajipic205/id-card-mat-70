import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { AuthGate } from "@/components/AuthGate";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "sonner";

export const Route = createFileRoute("/export")({
  head: () => ({
    meta: [
      { title: "Export Data — Makeathon 7.0 ID Card Studio" },
      {
        name: "description",
        content:
          "Download all teams with their members as a single JSON file.",
      },
    ],
  }),
  component: ExportPage,
});

function ExportPage() {
  const [teams, setTeams] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [teamsRes, membersRes] = await Promise.all([
        supabase.from("teams").select("*").order("team_number", { ascending: true }),
        supabase.from("members").select("*").order("created_at", { ascending: true }),
      ]);
      if (cancelled) return;
      if (teamsRes.error) toast.error("Teams: " + teamsRes.error.message);
      if (membersRes.error) toast.error("Members: " + membersRes.error.message);
      setTeams(teamsRes.data ?? []);
      setMembers(membersRes.data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const combined = useMemo(() => {
    const byTeam = new Map<string, any[]>();
    for (const m of members) {
      const tid = m.team_id ?? "__no_team__";
      if (!byTeam.has(tid)) byTeam.set(tid, []);
      byTeam.get(tid)!.push(m);
    }
    for (const arr of byTeam.values()) {
      arr.sort((a, b) => (a.member_order ?? 0) - (b.member_order ?? 0));
    }
    const teamsWithMembers = teams.map((t) => ({
      ...t,
      members: byTeam.get(t.id) ?? [],
    }));
    const orphanMembers = byTeam.get("__no_team__") ?? [];
    return {
      generated_at: new Date().toISOString(),
      team_count: teams.length,
      member_count: members.length,
      teams: teamsWithMembers,
      orphan_members: orphanMembers,
    };
  }, [teams, members]);

  function downloadJson() {
    const blob = new Blob([JSON.stringify(combined, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `makeathon7-data-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("JSON downloaded.");
  }

  const preview = useMemo(
    () => JSON.stringify(combined, null, 2).slice(0, 4000),
    [combined],
  );

  return (
    <AuthGate>
      <div className="min-h-screen">
        <Header />
        <Toaster theme="dark" position="top-right" richColors />
        <main className="mx-auto max-w-7xl px-6 py-10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Export Data</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Download every team along with its members (all fields) as a
              single JSON file.
            </p>
          </div>

          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-5">
            <div className="text-sm">
              {loading ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : (
                <>
                  <span className="font-semibold">{teams.length}</span> teams ·{" "}
                  <span className="font-semibold">{members.length}</span> members
                </>
              )}
            </div>
            <Button onClick={downloadJson} disabled={loading} size="lg">
              Download JSON
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Preview (first 4 KB)
            </h2>
            <pre className="max-h-[520px] overflow-auto rounded-md border border-border bg-muted/30 p-4 font-mono text-xs">
              {loading ? "Loading…" : preview}
            </pre>
          </div>
        </main>
      </div>
    </AuthGate>
  );
}
