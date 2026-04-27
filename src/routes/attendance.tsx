import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import SignatureCanvas from "react-signature-canvas";
import { Toaster, toast } from "sonner";
import { AuthGate } from "@/components/AuthGate";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  supabase,
  resolveStorageUrlAsync,
  type Member,
  type Team,
} from "@/lib/supabase";
import { useRoles } from "@/lib/use-roles";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/attendance")({
  head: () => ({
    meta: [
      { title: "Attendance — Make-A-Thon 7.0" },
      {
        name: "description",
        content: "Scan participant ID QR codes and capture signatures.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <AttendancePage />
    </AuthGate>
  ),
});

const SIGNATURE_BUCKET = "signatures";
const ACTIVE_SESSION_KEY = "m7.attendance.activeSessionId";

interface SessionRow {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
}

interface ScannedMember extends Member {
  team?: Team | null;
  photo_signed_url?: string | null;
}

interface AttendanceRow {
  id: string;
  session_id: string;
  unique_member_id: string;
  full_name: string | null;
  team_name: string | null;
  marked_at: string;
  checked: boolean;
  locked: boolean;
  signature_url: string | null;
}

function AttendancePage() {
  const { user } = useAuth();
  const { isAdmin, isStaff, loading } = useRoles();

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
          <h1 className="font-display text-3xl font-bold text-gradient-spider">
            Staff only
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Attendance marking is restricted to admin and volunteer accounts.
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
      <Toaster theme="dark" position="top-center" richColors closeButton expand visibleToasts={3} toastOptions={{ style: { fontSize: "0.95rem" } }} />
      <Header />
      <AttendanceWorkspace
        userId={user?.id ?? null}
        isAdmin={isAdmin}
      />
    </div>
  );
}

function AttendanceWorkspace({
  userId,
  isAdmin,
}: {
  userId: string | null;
  isAdmin: boolean;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedMember | null>(null);
  const [alreadyMarked, setAlreadyMarked] = useState<AttendanceRow | null>(
    null,
  );
  const [checked, setChecked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<AttendanceRow[]>([]);
  const [manualId, setManualId] = useState("");
  const sigRef = useRef<SignatureCanvas | null>(null);

  // Load sessions
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("attendance_sessions")
        .select("id, name, starts_at, ends_at")
        .order("starts_at", { ascending: false });
      if (error) toast.error(error.message);
      const list = (data as SessionRow[]) ?? [];
      setSessions(list);
      const stored =
        typeof window !== "undefined"
          ? localStorage.getItem(ACTIVE_SESSION_KEY)
          : null;
      const initial =
        list.find((s) => s.id === stored) ??
        list.find((s) => {
          const now = Date.now();
          return (
            new Date(s.starts_at).getTime() <= now &&
            new Date(s.ends_at).getTime() >= now
          );
        }) ??
        list[0];
      if (initial) setSessionId(initial.id);
    })();
  }, []);

  useEffect(() => {
    if (sessionId && typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
      loadRecent(sessionId);
    }
  }, [sessionId]);

  async function loadRecent(sid: string) {
    const { data } = await supabase
      .from("attendance")
      .select(
        "id, session_id, unique_member_id, full_name, team_name, marked_at, checked, locked, signature_url",
      )
      .eq("session_id", sid)
      .order("marked_at", { ascending: false })
      .limit(25);
    setRecent((data as AttendanceRow[]) ?? []);
  }

  function reset() {
    setScanned(null);
    setAlreadyMarked(null);
    setChecked(true);
    sigRef.current?.clear();
  }

  /** Returns null if window OK, else a reason string. */
  function checkWindow(s: SessionRow | null): null | "before_window" | "after_window" {
    if (!s) return null;
    const now = Date.now();
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    if (now < start) return "before_window";
    if (now > end) return "after_window";
    return null;
  }

  async function logAttempt(
    reason: string,
    uid: string | null,
    details?: Record<string, unknown>,
  ) {
    try {
      await supabase.from("attendance_attempts").insert({
        session_id: sessionId,
        unique_member_id: uid,
        reason,
        attempted_by: userId,
        details: details ?? null,
      });
    } catch {
      /* logging failure is not fatal */
    }
  }

  async function handleScannedId(rawId: string) {
    if (!sessionId) {
      toast.error("Pick an active session first.");
      await logAttempt("no_session", rawId.trim() || null);
      return;
    }
    const id = rawId.trim();
    if (!id) return;
    if (scanned?.unique_member_id === id) return;

    const active = sessions.find((s) => s.id === sessionId) ?? null;
    const winErr = checkWindow(active);
    if (winErr) {
      const when =
        winErr === "before_window"
          ? `starts at ${new Date(active!.starts_at).toLocaleString()}`
          : `ended at ${new Date(active!.ends_at).toLocaleString()}`;
      toast.error("Session is closed", {
        description: `This session ${when}. Attendance cannot be recorded right now.`,
        duration: 6000,
      });
      await logAttempt(winErr, id, {
        session_starts_at: active?.starts_at,
        session_ends_at: active?.ends_at,
      });
      return;
    }

    const { data: existing } = await supabase
      .from("attendance")
      .select(
        "id, session_id, unique_member_id, full_name, team_name, marked_at, checked, locked, signature_url",
      )
      .eq("session_id", sessionId)
      .eq("unique_member_id", id)
      .maybeSingle();
    if (existing) {
      setAlreadyMarked(existing as AttendanceRow);
      setScanned(null);
      await logAttempt("duplicate", id);
      toast.warning(
        `${(existing as AttendanceRow).full_name ?? id} already marked`,
        {
          description: new Date(
            (existing as AttendanceRow).marked_at,
          ).toLocaleString(),
        },
      );
      return;
    }

    const { data: member, error } = await supabase
      .from("members")
      .select("*")
      .eq("unique_member_id", id)
      .maybeSingle();
    if (error || !member) {
      toast.error(`No member found for ID ${id}`);
      await logAttempt("unknown_member", id);
      return;
    }
    let team: Team | null = null;
    if (member.team_id) {
      const { data: t } = await supabase
        .from("teams")
        .select("*")
        .eq("id", member.team_id)
        .maybeSingle();
      team = (t as Team) ?? null;
    }
    const photoSigned = await resolveStorageUrlAsync(member.photo_url);
    setAlreadyMarked(null);
    setScanned({
      ...(member as Member),
      team,
      photo_signed_url: photoSigned,
    });
    setChecked(true);
    sigRef.current?.clear();
    toast.success(`Loaded ${member.full_name}`);
  }

  async function saveAttendance() {
    if (!scanned || !sessionId) return;
    const active = sessions.find((s) => s.id === sessionId) ?? null;
    const winErr = checkWindow(active);
    if (winErr) {
      const when =
        winErr === "before_window"
          ? `starts at ${new Date(active!.starts_at).toLocaleString()}`
          : `ended at ${new Date(active!.ends_at).toLocaleString()}`;
      toast.error("Session is closed", {
        description: `This session ${when}.`,
        duration: 6000,
      });
      await logAttempt(winErr, scanned.unique_member_id);
      return;
    }
    if (!checked) {
      toast.error("Tick the present checkbox before saving.");
      return;
    }
    if (!sigRef.current || sigRef.current.isEmpty()) {
      toast.error("Please capture a signature before saving.");
      return;
    }
    setSaving(true);
    try {
      const dataUrl = sigRef.current
        .getTrimmedCanvas()
        .toDataURL("image/png");
      const blob = await (await fetch(dataUrl)).blob();
      const path = `${sessionId}/${scanned.unique_member_id}-${Date.now()}.png`;
      const { error: upErr } = await supabase.storage
        .from(SIGNATURE_BUCKET)
        .upload(path, blob, {
          contentType: "image/png",
          upsert: true,
        });
      if (upErr) throw upErr;
      const { data: signed } = await supabase.storage
        .from(SIGNATURE_BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 365);

      const { error: insErr } = await supabase.from("attendance").insert({
        session_id: sessionId,
        unique_member_id: scanned.unique_member_id,
        member_id: scanned.id,
        team_id: scanned.team_id,
        full_name: scanned.full_name,
        team_name: scanned.team?.team_name ?? null,
        checked,
        signature_path: path,
        signature_url: signed?.signedUrl ?? null,
        marked_by: userId,
        locked: true,
      });
      if (insErr) throw insErr;
      toast.success(`Attendance saved & locked for ${scanned.full_name}`);
      reset();
      loadRecent(sessionId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save attendance";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function unlockRow(row: AttendanceRow) {
    if (!isAdmin) return;
    const { error } = await supabase
      .from("attendance")
      .update({
        locked: false,
        unlocked_by: userId,
        unlocked_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) return toast.error(error.message);
    toast.success(`Unlocked ${row.full_name}. They can re-sign now.`);
    if (sessionId) loadRecent(sessionId);
    setAlreadyMarked(null);
    // Re-load member so admin can re-sign
    handleScannedId(row.unique_member_id);
  }

  async function deleteRow(row: AttendanceRow) {
    if (!isAdmin) return;
    if (!confirm(`Delete attendance for ${row.full_name}?`)) return;
    const { error } = await supabase.from("attendance").delete().eq("id", row.id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    if (sessionId) loadRecent(sessionId);
    setAlreadyMarked(null);
  }

  // If unlocked row exists for current scan target, allow overwrite save
  async function saveOverwrite() {
    if (!scanned || !sessionId) return;
    if (!sigRef.current || sigRef.current.isEmpty()) {
      toast.error("Please capture a signature before saving.");
      return;
    }
    setSaving(true);
    try {
      const dataUrl = sigRef.current.getTrimmedCanvas().toDataURL("image/png");
      const blob = await (await fetch(dataUrl)).blob();
      const path = `${sessionId}/${scanned.unique_member_id}-${Date.now()}.png`;
      const { error: upErr } = await supabase.storage
        .from(SIGNATURE_BUCKET)
        .upload(path, blob, { contentType: "image/png", upsert: true });
      if (upErr) throw upErr;
      const { data: signed } = await supabase.storage
        .from(SIGNATURE_BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      const { error: updErr } = await supabase
        .from("attendance")
        .update({
          checked,
          signature_path: path,
          signature_url: signed?.signedUrl ?? null,
          marked_by: userId,
          marked_at: new Date().toISOString(),
          locked: true,
        })
        .eq("session_id", sessionId)
        .eq("unique_member_id", scanned.unique_member_id);
      if (updErr) throw updErr;
      toast.success(`Re-signed & locked for ${scanned.full_name}`);
      reset();
      loadRecent(sessionId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const activeSession = sessions.find((s) => s.id === sessionId) ?? null;

  if (sessions.length === 0) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-16 text-center">
        <h1 className="font-display text-3xl font-bold text-gradient-spider">
          No sessions yet
        </h1>
        <p className="text-sm text-muted-foreground">
          An admin needs to create a session before attendance can be marked.
        </p>
        {isAdmin ? (
          <Link
            to="/sessions"
            className="inline-block rounded-md bg-gradient-spider px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow-pink"
          >
            Create a session
          </Link>
        ) : null}
      </main>
    );
  }

  const winState = checkWindow(activeSession);

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-3 py-6 sm:px-6 sm:py-8 lg:grid-cols-2">
      <section className="space-y-4">
        <header>
          <div className="text-xs uppercase tracking-widest text-m7-red">
            Active session
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={sessionId ?? ""}
              onChange={(e) => setSessionId(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
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
            {isAdmin ? (
              <Link
                to="/sessions"
                className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Manage
              </Link>
            ) : null}
          </div>
          {activeSession ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                {new Date(activeSession.starts_at).toLocaleString()} →{" "}
                {new Date(activeSession.ends_at).toLocaleString()}
              </span>
              {winState === null ? (
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
                  Open
                </span>
              ) : winState === "before_window" ? (
                <span className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-yellow-300">
                  Not started
                </span>
              ) : (
                <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-red-300">
                  Closed
                </span>
              )}
            </div>
          ) : null}
          <h1 className="mt-4 font-display text-3xl font-bold">
            <span className="text-gradient-spider">Scan</span> participant QR
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hold the ID card 10–20cm from the camera. Toggle the torch if there
            is glare.
          </p>
          <div className="gradient-bar mt-3 w-24 animate-shimmer" />
        </header>
        <ScannerCard onDecode={handleScannedId} />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="manual" className="text-xs text-muted-foreground">
              Or type the ID manually
            </Label>
            <Input
              id="manual"
              placeholder="e.g. is1011"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleScannedId(manualId);
                  setManualId("");
                }
              }}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              handleScannedId(manualId);
              setManualId("");
            }}
          >
            Look up
          </Button>
        </div>
      </section>

      <section className="space-y-4">
        <header>
          <div className="text-xs uppercase tracking-widest text-m7-red">
            Step 2
          </div>
          <h2 className="font-display text-3xl font-bold">
            Confirm <span className="text-gradient-spider">&amp; Sign</span>
          </h2>
          <div className="gradient-bar mt-3 w-24 animate-shimmer" />
        </header>

        {alreadyMarked ? (
          <AlreadyMarkedCard
            row={alreadyMarked}
            isAdmin={isAdmin}
            onDismiss={() => setAlreadyMarked(null)}
            onUnlock={() => unlockRow(alreadyMarked)}
            onDelete={() => deleteRow(alreadyMarked)}
          />
        ) : scanned ? (
          <div className="rounded-2xl border border-border bg-card p-5 shadow-glow-pink">
            <div className="flex items-start gap-4">
              {scanned.photo_signed_url ? (
                <img
                  src={scanned.photo_signed_url}
                  alt={scanned.full_name}
                  className="h-24 w-24 rounded-xl border border-border object-cover"
                />
              ) : (
                <div className="grid h-24 w-24 place-items-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                  No photo
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {scanned.unique_member_id}
                  {scanned.is_leader ? " · Team Leader" : ""}
                </div>
                <div className="truncate text-xl font-semibold">
                  {scanned.full_name}
                </div>
                {scanned.team ? (
                  <div className="mt-1 text-sm text-muted-foreground">
                    Team{" "}
                    <span className="font-medium text-foreground">
                      {scanned.team.team_name}
                    </span>
                    {scanned.team.team_number != null
                      ? ` · #${scanned.team.team_number}`
                      : ""}
                  </div>
                ) : null}
                {scanned.college_email ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {scanned.college_email}
                  </div>
                ) : null}
              </div>
            </div>

            <label className="mt-5 flex items-center gap-3 rounded-md border border-border bg-background/50 p-3">
              <Checkbox
                checked={checked}
                onCheckedChange={(v) => setChecked(v === true)}
                id="present"
              />
              <span className="text-sm">
                I confirm{" "}
                <span className="font-medium">{scanned.full_name}</span> is
                present.
              </span>
            </label>

            <div className="mt-4">
              <Label className="text-xs text-muted-foreground">
                Member signature
              </Label>
              <div className="mt-1 overflow-hidden rounded-md border border-border bg-white">
                <SignatureCanvas
                  ref={(r) => {
                    sigRef.current = r;
                  }}
                  penColor="#0a0a0a"
                  canvasProps={{
                    className: "w-full h-44",
                  }}
                />
              </div>
              <div className="mt-2 flex justify-between text-xs">
                <button
                  type="button"
                  className="text-muted-foreground underline"
                  onClick={() => sigRef.current?.clear()}
                >
                  Clear signature
                </button>
                <span className="text-muted-foreground">
                  Sign inside the white area
                </span>
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <Button
                onClick={saveAttendance}
                disabled={saving}
                className="flex-1 bg-gradient-spider text-primary-foreground shadow-glow-pink"
              >
                {saving ? "Saving…" : "Save & lock"}
              </Button>
              {isAdmin ? (
                <Button
                  variant="outline"
                  onClick={saveOverwrite}
                  disabled={saving}
                  title="Overwrite existing signature for this member in this session"
                >
                  Overwrite
                </Button>
              ) : null}
              <Button variant="outline" onClick={reset} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border p-10 text-sm text-muted-foreground">
            Scan a QR code to load member details.
          </div>
        )}

        <RecentList
          rows={recent}
          isAdmin={isAdmin}
          onUnlock={unlockRow}
          onDelete={deleteRow}
        />
      </section>
    </main>
  );
}

function AlreadyMarkedCard({
  row,
  isAdmin,
  onDismiss,
  onUnlock,
  onDelete,
}: {
  row: AttendanceRow;
  isAdmin: boolean;
  onDismiss: () => void;
  onUnlock: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-2xl border border-yellow-500/40 bg-yellow-500/5 p-5">
      <div className="text-xs uppercase tracking-widest text-yellow-400">
        Already marked {row.locked ? "· Locked" : "· Unlocked"}
      </div>
      <div className="mt-1 text-xl font-semibold">{row.full_name}</div>
      <div className="text-sm text-muted-foreground">
        {row.unique_member_id}
        {row.team_name ? ` · ${row.team_name}` : ""}
      </div>
      <div className="mt-2 text-sm">
        Marked at{" "}
        <span className="font-medium">
          {new Date(row.marked_at).toLocaleString()}
        </span>
      </div>
      {row.signature_url ? (
        <img
          src={row.signature_url}
          alt="signature"
          className="mt-3 h-20 rounded border border-border bg-white p-1"
        />
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
        {isAdmin ? (
          <>
            <Button
              onClick={onUnlock}
              className="bg-gradient-spider text-primary-foreground"
            >
              Unlock & re-sign
            </Button>
            <Button variant="outline" onClick={onDelete}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RecentList({
  rows,
  isAdmin,
  onUnlock,
  onDelete,
}: {
  rows: AttendanceRow[];
  isAdmin: boolean;
  onUnlock: (r: AttendanceRow) => void;
  onDelete: (r: AttendanceRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-display text-sm font-semibold">
          Recent check-ins (this session)
        </div>
        <span className="text-xs text-muted-foreground">{rows.length}</span>
      </div>
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">
                {r.full_name}{" "}
                {r.locked ? (
                  <span className="ml-1 rounded bg-m7-red/20 px-1.5 py-0.5 text-[10px] uppercase text-m7-red">
                    locked
                  </span>
                ) : (
                  <span className="ml-1 rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] uppercase text-yellow-300">
                    unlocked
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {r.unique_member_id}
                {r.team_name ? ` · ${r.team_name}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {new Date(r.marked_at).toLocaleTimeString()}
              </span>
              {isAdmin && r.locked ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onUnlock(r)}
                >
                  Unlock
                </Button>
              ) : null}
              {isAdmin ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDelete(r)}
                >
                  ✕
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Continuous QR scanner using ZXing — supports torch and small QRs. */
function ScannerCard({ onDecode }: { onDecode: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const lastScanRef = useRef<{ text: string; at: number }>({
    text: "",
    at: 0,
  });

  const reader = useMemo(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80 });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach((t) => t.stop());
        const list = await BrowserMultiFormatReader.listVideoInputDevices();
        if (cancelled) return;
        setDevices(list);
        const back = list.find((d) => /back|rear|environment/i.test(d.label));
        setDeviceId((back ?? list[0])?.deviceId ?? null);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Camera unavailable";
        setError(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!deviceId || !videoRef.current) return;
    let cancelled = false;
    setError(null);
    setRunning(false);

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: { exact: deviceId },
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // @ts-expect-error focusMode is not in standard lib types
        focusMode: "continuous",
      },
      audio: false,
    };

    reader
      .decodeFromConstraints(constraints, videoRef.current, (result) => {
        if (cancelled) return;
        if (result) {
          const text = result.getText();
          const now = Date.now();
          if (
            text === lastScanRef.current.text &&
            now - lastScanRef.current.at < 1500
          ) {
            return;
          }
          lastScanRef.current = { text, at: now };
          onDecode(text);
        }
      })
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setRunning(true);
        const stream = videoRef.current?.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        const caps =
          (track?.getCapabilities?.() as MediaTrackCapabilities & {
            torch?: boolean;
          }) ?? {};
        setTorchSupported(Boolean(caps.torch));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "Failed to start camera";
        setError(msg);
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [deviceId, reader, onDecode]);

  async function toggleTorch() {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      // @ts-expect-error torch is not in the standard MediaTrackConstraintSet type
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(!torchOn);
    } catch {
      toast.error("Torch is not supported on this device");
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-black shadow-glow-cyan">
      <div className="relative aspect-[4/3] w-full">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          muted
          playsInline
        />
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="relative h-2/3 w-2/3 max-w-sm">
            <div className="absolute inset-0 rounded-xl border-2 border-white/30" />
            <span className="absolute -left-px -top-px h-6 w-6 border-l-2 border-t-2 border-m7-red" />
            <span className="absolute -right-px -top-px h-6 w-6 border-r-2 border-t-2 border-m7-red" />
            <span className="absolute -bottom-px -left-px h-6 w-6 border-b-2 border-l-2 border-m7-red" />
            <span className="absolute -bottom-px -right-px h-6 w-6 border-b-2 border-r-2 border-m7-red" />
          </div>
        </div>
        {error ? (
          <div className="absolute inset-0 grid place-items-center bg-black/70 p-4 text-center text-sm text-destructive">
            {error}
          </div>
        ) : !running ? (
          <div className="absolute inset-0 grid place-items-center bg-black/40 text-sm text-white/80">
            Starting camera…
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card p-3">
        {devices.length > 1 ? (
          <select
            value={deviceId ?? ""}
            onChange={(e) => setDeviceId(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${d.deviceId.slice(0, 4)}`}
              </option>
            ))}
          </select>
        ) : null}
        {torchSupported ? (
          <Button
            type="button"
            size="sm"
            variant={torchOn ? "default" : "outline"}
            onClick={toggleTorch}
          >
            {torchOn ? "Torch on" : "Torch off"}
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {running ? "Scanning…" : "Idle"}
        </span>
      </div>
    </div>
  );
}
