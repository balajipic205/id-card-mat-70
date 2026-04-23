import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cnwchucuzheqpzoyuybi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNud2NodWN1emhlcXB6b3l1eWJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1OTgwMzQsImV4cCI6MjA5MjE3NDAzNH0.0ztpxH6-V6TVf96hP46DcFmPKnw7GKcC_Xpf7uk_Iso";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
export const PHOTO_BUCKET = "member-photos";

// In-memory cache so we don't re-sign on every render.
const signedUrlCache = new Map<string, { url: string; expires: number }>();

/**
 * Resolve a photo reference to a usable URL.
 * - Full http(s) URLs are returned as-is.
 * - Storage paths are signed using the current authenticated session
 *   (admin login). No public RLS / bucket changes required.
 */
export async function resolvePhotoUrlAsync(
  photo: string | null | undefined
): Promise<string | null> {
  if (!photo) return null;
  if (photo.startsWith("http://") || photo.startsWith("https://")) return photo;

  const now = Date.now();
  const cached = signedUrlCache.get(photo);
  if (cached && cached.expires > now + 30_000) return cached.url;

  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(photo, 60 * 60); // 1h
  if (error || !data?.signedUrl) return null;

  signedUrlCache.set(photo, { url: data.signedUrl, expires: now + 60 * 60 * 1000 });
  return data.signedUrl;
}

/** Fetch a photo and return a base64 data URL — useful for html2canvas exports
 *  to avoid CORS taint and tainted canvas errors. */
export async function fetchPhotoAsDataUrl(
  photo: string | null | undefined
): Promise<string | null> {
  const url = await resolvePhotoUrlAsync(photo);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface Member {
  id: string;
  unique_member_id: string;
  team_id: string | null;
  member_order: number | null;
  is_leader: boolean | null;
  full_name: string;
  college_email: string | null;
  personal_email: string | null;
  photo_url: string | null;
  created_at: string | null;
}
