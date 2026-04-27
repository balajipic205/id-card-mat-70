import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  Document,
  Packer,
  Paragraph,
  Table as DocxTable,
  TableRow as DocxRow,
  TableCell as DocxCell,
  TextRun,
  HeadingLevel,
  AlignmentType,
  WidthType,
  ImageRun,
  PageOrientation,
} from "docx";
import { saveAs } from "file-saver";
import { AuthGate } from "@/components/AuthGate";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useRoles } from "@/lib/use-roles";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Attendance Dashboard — Make-A-Thon 7.0" },
      { name: "description", content: "Analytics and exports for attendance." },
    ],
  }),
  component: () => (
    <AuthGate>
      <DashboardPage />
    </AuthGate>
  ),
});

interface SessionRow {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
}

interface AttendanceRow {
  id: string;
  session_id: string;
  unique_member_id: string;
  member_id: string | null;
  team_id: string | null;
  full_name: string | null;
  team_name: string | null;
  marked_at: string;
  signature_url: string | null;
  signature_path: string | null;
}

interface MemberRow {
  id: string;
  unique_member_id: string;
  team_id: string | null;
  full_name: string;
  college_email: string | null;
  is_leader: boolean | null;
}

interface TeamRow {
  id: string;
  team_number: number | null;
  team_name: string;
  problem_statement_id: string | null;
  problem_statement_name: string | null;
}

/** Heuristic: SVCE if college_email ends with svce.ac.in, else "Other". */
function isSvce(email: string | null | undefined) {
  if (!email) return false;
  return /@svce\.ac\.in\s*$/i.test(email.trim());
}

/** Derive a human-friendly college label from an email address. */
function collegeNameFromEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const at = email.indexOf("@");
  if (at < 0) return "—";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return "—";
  if (/(^|\.)svce\.ac\.in$/.test(domain)) return "SVCE";
  // Strip common TLD-ish suffixes to get the institution token.
  const stripped = domain
    .replace(/\.(ac\.in|edu\.in|edu|ac\.uk|edu\.au|ac|in|com|org|net)$/i, "")
    .replace(/\.[a-z]{2,3}$/i, "");
  const head = stripped.split(".").pop() || domain;
  // Uppercase short tokens (likely acronyms), Title-case longer ones.
  return head.length <= 5 ? head.toUpperCase() : head.charAt(0).toUpperCase() + head.slice(1);
}

/** Pick a representative college name for a team (most common across members). */
function teamCollegeName(emails: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const e of emails) {
    const name = collegeNameFromEmail(e);
    if (name === "—") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "—";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Track inferred from problem_statement_id prefix: hw / sw / is. */
function inferTrack(psId: string | null | undefined): "HW" | "SW" | "IS" | "—" {
  if (!psId) return "—";
  const v = psId.trim().toLowerCase();
  if (v.startsWith("hw")) return "HW";
  if (v.startsWith("sw")) return "SW";
  if (v.startsWith("is")) return "IS";
  return "—";
}

function DashboardPage() {
  const { isStaff, loading } = useRoles();
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
  if (!isStaff) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="mx-auto max-w-xl px-6 py-24 text-center">
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-gradient-spider">
            Staff only
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Dashboard access is restricted to admin and volunteer accounts.
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
      <Toaster
        theme="dark"
        position="top-center"
        richColors
        closeButton
        expand
        visibleToasts={3}
      />
      <Header />
      <DashboardWorkspace />
    </div>
  );
}

function DashboardWorkspace() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [s, m, t] = await Promise.all([
        supabase
          .from("attendance_sessions")
          .select("id, name, starts_at, ends_at")
          .order("starts_at", { ascending: false }),
        supabase
          .from("members")
          .select("id, unique_member_id, team_id, full_name, college_email, is_leader"),
        supabase
          .from("teams")
          .select("id, team_number, team_name, problem_statement_id, problem_statement_name"),
      ]);
      if (s.error) toast.error(s.error.message);
      const list = (s.data as SessionRow[]) ?? [];
      setSessions(list);
      setMembers((m.data as MemberRow[]) ?? []);
      setTeams((t.data as TeamRow[]) ?? []);
      if (list[0]) setSessionId(list[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const { data, error } = await supabase
        .from("attendance")
        .select(
          "id, session_id, unique_member_id, member_id, team_id, full_name, team_name, marked_at, signature_url, signature_path",
        )
        .eq("session_id", sessionId)
        .order("marked_at", { ascending: true });
      if (error) toast.error(error.message);
      setAttendance((data as AttendanceRow[]) ?? []);
    })();
  }, [sessionId]);

  const teamMap = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const presentIds = useMemo(
    () => new Set(attendance.map((a) => a.unique_member_id)),
    [attendance],
  );

  /** Group members by team for table rendering. */
  const grouped = useMemo(() => {
    const byTeam = new Map<
      string,
      {
        team: TeamRow;
        members: MemberRow[];
        college: "SVCE" | "Other";
        collegeName: string;
      }
    >();
    for (const m of members) {
      if (!m.team_id) continue;
      const team = teamMap.get(m.team_id);
      if (!team) continue;
      let entry = byTeam.get(m.team_id);
      if (!entry) {
        entry = { team, members: [], college: "Other", collegeName: "—" };
        byTeam.set(m.team_id, entry);
      }
      entry.members.push(m);
    }
    // Decide college bucket + display name per team.
    for (const e of byTeam.values()) {
      e.college = e.members.some((m) => isSvce(m.college_email))
        ? "SVCE"
        : "Other";
      e.collegeName = teamCollegeName(e.members.map((m) => m.college_email));
    }
    return Array.from(byTeam.values()).sort(
      (a, b) => (a.team.team_number ?? 9999) - (b.team.team_number ?? 9999),
    );
  }, [members, teamMap]);

  const stats = useMemo(() => {
    const total = members.length;
    const present = attendance.length;
    const absent = total - present;
    const trackCounts: Record<string, { present: number; total: number }> = {
      HW: { present: 0, total: 0 },
      SW: { present: 0, total: 0 },
      IS: { present: 0, total: 0 },
      "—": { present: 0, total: 0 },
    };
    const collegeCounts = {
      SVCE: { present: 0, total: 0 },
      Other: { present: 0, total: 0 },
    };
    for (const g of grouped) {
      const track = inferTrack(g.team.problem_statement_id);
      for (const m of g.members) {
        trackCounts[track].total++;
        collegeCounts[g.college].total++;
        if (presentIds.has(m.unique_member_id)) {
          trackCounts[track].present++;
          collegeCounts[g.college].present++;
        }
      }
    }
    return { total, present, absent, trackCounts, collegeCounts };
  }, [members, attendance, grouped, presentIds]);

  const teamRows = useMemo(() => {
    return grouped.map((g) => {
      const presentCount = g.members.filter((m) =>
        presentIds.has(m.unique_member_id),
      ).length;
      return {
        ...g,
        track: inferTrack(g.team.problem_statement_id),
        presentCount,
      };
    });
  }, [grouped, presentIds]);

  const activeSession = sessions.find((s) => s.id === sessionId) ?? null;

  async function fetchSignatureBytes(url: string): Promise<Uint8Array | null> {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  function buildExportRows(college: "SVCE" | "Other") {
    const rows: Array<{
      sno: number;
      teamName: string;
      psid: string;
      track: string;
      collegeMark: string;
      memberName: string;
      uid: string;
      signatureUrl: string | null;
      present: boolean;
    }> = [];
    let sno = 1;
    for (const g of teamRows) {
      if (g.college !== college) continue;
      for (const m of g.members) {
        const att = attendance.find((a) => a.unique_member_id === m.unique_member_id);
        rows.push({
          sno: sno++,
          teamName: g.team.team_name,
          psid: g.team.problem_statement_id ?? "—",
          track: g.track,
          collegeMark: collegeNameFromEmail(m.college_email) !== "—"
            ? collegeNameFromEmail(m.college_email)
            : g.collegeName,
          memberName: m.full_name,
          uid: m.unique_member_id,
          signatureUrl: att?.signature_url ?? null,
          present: !!att,
        });
      }
    }
    return rows;
  }

  /** Rows mirroring the on-screen Teams table for the "Teams Summary" export. */
  function buildTeamsSummaryRows() {
    return teamRows.map((g, i) => ({
      sno: i + 1,
      teamName: g.team.team_name,
      teamNumber: g.team.team_number,
      psid: g.team.problem_statement_id ?? "—",
      track: g.track,
      college: g.collegeName,
      memberCount: g.members.length,
      presentCount: g.presentCount,
    }));
  }

  async function exportPdf(college: "SVCE" | "Other") {
    if (!activeSession) return toast.error("No session selected");
    setBusy(true);
    try {
      const rows = buildExportRows(college);
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      doc.setFont("times", "bold");
      doc.setFontSize(16);
      doc.text("MAKE-A-THON 7.0", doc.internal.pageSize.getWidth() / 2, 36, {
        align: "center",
      });
      doc.setFontSize(12);
      doc.setFont("times", "normal");
      const sub = `Session: ${activeSession.name}  |  ${new Date(
        activeSession.starts_at,
      ).toLocaleString()}  →  ${new Date(activeSession.ends_at).toLocaleString()}`;
      doc.text(sub, doc.internal.pageSize.getWidth() / 2, 54, { align: "center" });
      doc.text(
        `Attendance — ${college === "SVCE" ? "SVCE" : "Other Colleges"}`,
        doc.internal.pageSize.getWidth() / 2,
        72,
        { align: "center" },
      );

      // Pre-fetch signatures as data URLs
      const sigs: (string | null)[] = await Promise.all(
        rows.map(async (r) => {
          if (!r.signatureUrl) return null;
          try {
            const res = await fetch(r.signatureUrl);
            if (!res.ok) return null;
            const blob = await res.blob();
            return await new Promise<string>((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result as string);
              fr.onerror = reject;
              fr.readAsDataURL(blob);
            });
          } catch {
            return null;
          }
        }),
      );

      autoTable(doc, {
        startY: 86,
        head: [
          [
            "S.No",
            "Team Name",
            "PS ID",
            "Track",
            "College",
            "Member Name",
            "Signature",
          ],
        ],
        body: rows.map((r, i) => [
          String(r.sno),
          r.teamName,
          r.psid,
          r.track,
          r.collegeMark,
          `${r.memberName} (${r.uid})${r.present ? "" : " — Absent"}`,
          "",
        ]),
        styles: {
          font: "times",
          fontSize: 12,
          cellPadding: 4,
          valign: "middle",
        },
        headStyles: {
          font: "times",
          fontStyle: "bold",
          fontSize: 12,
          fillColor: [120, 20, 20],
          textColor: 255,
        },
        columnStyles: {
          0: { cellWidth: 36, halign: "center" },
          2: { cellWidth: 60 },
          3: { cellWidth: 50, halign: "center" },
          4: { cellWidth: 70 },
          6: { cellWidth: 110, minCellHeight: 36 },
        },
        didDrawCell: (data) => {
          if (
            data.section === "body" &&
            data.column.index === 6 &&
            sigs[data.row.index]
          ) {
            const img = sigs[data.row.index]!;
            const pad = 2;
            const w = data.cell.width - pad * 2;
            const h = data.cell.height - pad * 2;
            try {
              doc.addImage(
                img,
                "PNG",
                data.cell.x + pad,
                data.cell.y + pad,
                w,
                h,
              );
            } catch {
              /* ignore */
            }
          }
        },
      });

      doc.save(
        `MakeAThon7_Attendance_${activeSession.name.replace(/\s+/g, "_")}_${college}.pdf`,
      );
      toast.success("PDF downloaded");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to export PDF");
    } finally {
      setBusy(false);
    }
  }

  async function exportDocx(college: "SVCE" | "Other") {
    if (!activeSession) return toast.error("No session selected");
    setBusy(true);
    try {
      const rows = buildExportRows(college);
      const sigBytes: (Uint8Array | null)[] = await Promise.all(
        rows.map((r) => (r.signatureUrl ? fetchSignatureBytes(r.signatureUrl) : Promise.resolve(null))),
      );

      const TIMES = "Times New Roman";
      const headerCells = [
        "S.No",
        "Team Name",
        "PS ID",
        "Track",
        "College",
        "Member Name",
        "Signature",
      ];
      const headerRow = new DocxRow({
        tableHeader: true,
        children: headerCells.map(
          (c) =>
            new DocxCell({
              shading: { fill: "7A1414" },
              width: { size: 1500, type: WidthType.DXA },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: c,
                      bold: true,
                      color: "FFFFFF",
                      font: TIMES,
                      size: 24, // 12pt
                    }),
                  ],
                }),
              ],
            }),
        ),
      });

      const bodyRows = rows.map((r, i) => {
        const sigChildren: Paragraph[] = [];
        const bytes = sigBytes[i];
        if (bytes) {
          sigChildren.push(
            new Paragraph({
              children: [
                new ImageRun({
                  type: "png",
                  data: bytes,
                  transformation: { width: 110, height: 40 },
                  altText: { title: "sig", description: "signature", name: "sig" },
                }),
              ],
            }),
          );
        } else {
          sigChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: r.present ? "" : "Absent",
                  font: TIMES,
                  size: 24,
                  italics: true,
                }),
              ],
            }),
          );
        }
        const text = (s: string) =>
          new Paragraph({
            children: [new TextRun({ text: s, font: TIMES, size: 24 })],
          });
        return new DocxRow({
          children: [
            new DocxCell({ children: [text(String(r.sno))] }),
            new DocxCell({ children: [text(r.teamName)] }),
            new DocxCell({ children: [text(r.psid)] }),
            new DocxCell({ children: [text(r.track)] }),
            new DocxCell({ children: [text(r.collegeMark)] }),
            new DocxCell({ children: [text(`${r.memberName} (${r.uid})`)] }),
            new DocxCell({ children: sigChildren }),
          ],
        });
      });

      const table = new DocxTable({
        width: { size: 9000, type: WidthType.DXA },
        rows: [headerRow, ...bodyRows],
      });

      const doc = new Document({
        styles: {
          default: {
            document: { run: { font: TIMES, size: 24 } },
          },
        },
        sections: [
          {
            properties: {
              page: {
                size: {
                  width: 12240,
                  height: 15840,
                  orientation: PageOrientation.LANDSCAPE,
                },
                margin: { top: 720, right: 720, bottom: 720, left: 720 },
              },
            },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                heading: HeadingLevel.HEADING_1,
                children: [
                  new TextRun({
                    text: "MAKE-A-THON 7.0",
                    bold: true,
                    font: TIMES,
                    size: 32,
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `Session: ${activeSession.name}`,
                    font: TIMES,
                    size: 24,
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `${new Date(activeSession.starts_at).toLocaleString()}  →  ${new Date(activeSession.ends_at).toLocaleString()}`,
                    font: TIMES,
                    size: 24,
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `Attendance — ${college === "SVCE" ? "SVCE" : "Other Colleges"}`,
                    bold: true,
                    font: TIMES,
                    size: 24,
                  }),
                ],
              }),
              new Paragraph({ children: [new TextRun({ text: " ", font: TIMES, size: 24 })] }),
              table,
            ],
          },
        ],
      });

      const blob = await Packer.toBlob(doc);
      saveAs(
        blob,
        `MakeAThon7_Attendance_${activeSession.name.replace(/\s+/g, "_")}_${college}.docx`,
      );
      toast.success("Word document downloaded");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to export Word doc");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-3 py-6 sm:px-6 sm:py-8">
      <header>
        <div className="text-xs uppercase tracking-widest text-m7-red">
          Attendance
        </div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold">
          <span className="text-gradient-spider">Dashboard</span> & Reports
        </h1>
        <div className="gradient-bar mt-3 w-24 animate-shimmer" />
      </header>

      <section className="rounded-2xl border border-border bg-card/70 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              Session
            </div>
            <select
              value={sessionId ?? ""}
              onChange={(e) => setSessionId(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} —{" "}
                  {new Date(s.starts_at).toLocaleString([], {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => exportPdf("SVCE")}
              className="bg-gradient-spider text-primary-foreground"
            >
              PDF · SVCE
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => exportPdf("Other")}
            >
              PDF · Other Colleges
            </Button>
            <Button
              disabled={busy}
              onClick={() => exportDocx("SVCE")}
              className="bg-gradient-spider text-primary-foreground"
            >
              Word · SVCE
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => exportDocx("Other")}
            >
              Word · Other Colleges
            </Button>
          </div>
        </div>
      </section>

      {/* KPI cards */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Total members" value={stats.total} />
        <Kpi label="Present" value={stats.present} accent="green" />
        <Kpi label="Absent" value={stats.absent} accent="red" />
        <Kpi
          label="Attendance %"
          value={
            stats.total > 0
              ? `${Math.round((stats.present / stats.total) * 100)}%`
              : "—"
          }
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          title="By Track"
          rows={[
            { label: "HW", ...stats.trackCounts.HW },
            { label: "SW", ...stats.trackCounts.SW },
            { label: "IS", ...stats.trackCounts.IS },
            { label: "—", ...stats.trackCounts["—"] },
          ]}
        />
        <BreakdownCard
          title="By College"
          rows={[
            { label: "SVCE", ...stats.collegeCounts.SVCE },
            { label: "Other", ...stats.collegeCounts.Other },
          ]}
        />
      </section>

      <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-6">
        <h2 className="font-display text-lg font-semibold">Teams</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-3">Team</th>
                <th className="py-2 pr-3">PS ID</th>
                <th className="py-2 pr-3">Track</th>
                <th className="py-2 pr-3">College</th>
                <th className="py-2 pr-3">Members</th>
                <th className="py-2 pr-3">Present</th>
              </tr>
            </thead>
            <tbody>
              {teamRows.map((g) => {
                const ratio = g.members.length === 0 ? 0 : g.presentCount / g.members.length;
                const tone =
                  ratio === 1
                    ? "text-emerald-300"
                    : ratio === 0
                      ? "text-red-300"
                      : "text-yellow-300";
                return (
                  <tr key={g.team.id} className="border-b border-border/50">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{g.team.team_name}</div>
                      <div className="text-xs text-muted-foreground">
                        #{g.team.team_number ?? "—"}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">{g.team.problem_statement_id ?? "—"}</td>
                    <td className="py-2 pr-3">{g.track}</td>
                    <td className="py-2 pr-3">{g.collegeName}</td>
                    <td className="py-2 pr-3">{g.members.length}</td>
                    <td className={"py-2 pr-3 font-medium " + tone}>
                      {g.presentCount}/{g.members.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-6">
        <h2 className="font-display text-lg font-semibold">
          Members not yet checked in
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {members
            .filter((m) => !presentIds.has(m.unique_member_id))
            .map((m) => {
              const team = m.team_id ? teamMap.get(m.team_id) : null;
              return (
                <li
                  key={m.id}
                  className="rounded-md border border-border bg-background/40 px-3 py-2 text-sm"
                >
                  <div className="font-medium">{m.full_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.unique_member_id}
                    {team ? ` · ${team.team_name}` : ""}
                  </div>
                </li>
              );
            })}
        </ul>
      </section>
    </main>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "green" | "red";
}) {
  const tone =
    accent === "green"
      ? "text-emerald-300"
      : accent === "red"
        ? "text-red-300"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={"mt-1 font-display text-2xl font-bold " + tone}>{value}</div>
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; present: number; total: number }>;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="font-display text-sm font-semibold">{title}</div>
      <ul className="mt-3 space-y-2 text-sm">
        {rows.map((r) => {
          const pct = r.total === 0 ? 0 : Math.round((r.present / r.total) * 100);
          return (
            <li key={r.label}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{r.label}</span>
                <span className="text-muted-foreground">
                  {r.present}/{r.total} · {pct}%
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-gradient-spider"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
