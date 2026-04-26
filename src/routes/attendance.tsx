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
      { title: "Attendance — Makeathon 7.0" },
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

interface ScannedMember extends Member {
  team?: Team | null;
  photo_signed_url?: string | null;
}

interface AttendanceRow {
  id: string;
  unique_member_id: string;
  full_name: string | null;
  team_name: string | null;
  marked_at: string;
  checked: boolean;
}

function AttendancePage() {
  const { user } = useAuth();
  const { isAdmin, loading: rolesLoading } = useRoles();

  if (rolesLoading) {
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
          <h1 className="text-3xl font-bold text-gradient-spider">
            Admins only
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Attendance marking is restricted to admin accounts. Ask the event
            lead to grant your account the <code>admin</code> role in the
            Cloud database.
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
      <AttendanceWorkspace adminUserId={user?.id ?? null} />
    </div>
  );
}

function AttendanceWorkspace({ adminUserId }: { adminUserId: string | null }) {
  const [scanned, setScanned] = useState<ScannedMember | null>(null);
  const [alreadyMarked, setAlreadyMarked] = useState<AttendanceRow | null>(
    null,
  );
  const [checked, setChecked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<AttendanceRow[]>([]);
  const [manualId, setManualId] = useState("");
  const sigRef = useRef<SignatureCanvas | null>(null);

  async function loadRecent() {
    const { data } = await supabase
      .from("attendance")
      .select("id, unique_member_id, full_name, team_name, marked_at, checked")
      .order("marked_at", { ascending: false })
      .limit(20);
    setRecent((data as AttendanceRow[]) ?? []);
  }

  useEffect(() => {
    loadRecent();
  }, []);

  function reset() {
    setScanned(null);
    setAlreadyMarked(null);
    setChecked(true);
    sigRef.current?.clear();
  }

  async function handleScannedId(rawId: string) {
    const id = rawId.trim();
    if (!id) return;
    if (scanned?.unique_member_id === id) return; // ignore identical re-scan
    // Look up existing attendance first
    const { data: existing } = await supabase
      .from("attendance")
      .select("id, unique_member_id, full_name, team_name, marked_at, checked")
      .eq("unique_member_id", id)
      .maybeSingle();
    if (existing) {
      setAlreadyMarked(existing as AttendanceRow);
      setScanned(null);
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
    if (!scanned) return;
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
      // 1. Get signature as PNG blob
      const dataUrl = sigRef.current
        .getTrimmedCanvas()
        .toDataURL("image/png");
      const blob = await (await fetch(dataUrl)).blob();
      const path = `${scanned.unique_member_id}-${Date.now()}.png`;
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

      // 2. Insert attendance row
      const { error: insErr } = await supabase.from("attendance").insert({
        unique_member_id: scanned.unique_member_id,
        member_id: scanned.id,
        team_id: scanned.team_id,
        full_name: scanned.full_name,
        team_name: scanned.team?.team_name ?? null,
        checked,
        signature_path: path,
        signature_url: signed?.signedUrl ?? null,
        marked_by: adminUserId,
      });
      if (insErr) throw insErr;
      toast.success(`Attendance saved for ${scanned.full_name}`);
      reset();
      loadRecent();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save attendance";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-2">
      <section className="space-y-4">
        <header>
          <div className="text-xs uppercase tracking-widest text-m7-cyan">
            Step 1
          </div>
          <h1 className="font-display text-3xl font-bold">
            <span className="text-gradient-spider">Scan</span> participant QR
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hold the ID card 10–20cm in front of the camera. Toggle the torch
            if there is glare.
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
          <div className="text-xs uppercase tracking-widest text-m7-pink">
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
            onDismiss={() => setAlreadyMarked(null)}
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
                {saving ? "Saving…" : "Save attendance"}
              </Button>
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

        <RecentList rows={recent} />
      </section>
    </main>
  );
}

function AlreadyMarkedCard({
  row,
  onDismiss,
}: {
  row: AttendanceRow;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-2xl border border-yellow-500/40 bg-yellow-500/5 p-5">
      <div className="text-xs uppercase tracking-widest text-yellow-400">
        Already marked
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
      <Button variant="outline" className="mt-4" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function RecentList({ rows }: { rows: AttendanceRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-display text-sm font-semibold">
          Recent check-ins
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} latest</span>
      </div>
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{r.full_name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {r.unique_member_id}
                {r.team_name ? ` · ${r.team_name}` : ""}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {new Date(r.marked_at).toLocaleTimeString()}
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

  // Build a hint set tuned for QR
  const reader = useMemo(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80 });
  }, []);

  // Enumerate cameras
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Prompt once so labels appear
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

  // Start / restart scanning when device changes
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
        // Probe torch capability
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
        {/* Targeting overlay */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="relative h-2/3 w-2/3 max-w-sm">
            <div className="absolute inset-0 rounded-xl border-2 border-white/30" />
            <span className="absolute -left-px -top-px h-6 w-6 border-l-2 border-t-2 border-m7-cyan" />
            <span className="absolute -right-px -top-px h-6 w-6 border-r-2 border-t-2 border-m7-pink" />
            <span className="absolute -bottom-px -left-px h-6 w-6 border-b-2 border-l-2 border-m7-pink" />
            <span className="absolute -bottom-px -right-px h-6 w-6 border-b-2 border-r-2 border-m7-cyan" />
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
