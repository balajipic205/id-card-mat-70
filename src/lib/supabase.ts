import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cnwchucuzheqpzoyuybi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNud2NodWN1emhlcXB6b3l1eWJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1OTgwMzQsImV4cCI6MjA5MjE3NDAzNH0.0ztpxH6-V6TVf96hP46DcFmPKnw7GKcC_Xpf7uk_Iso";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
export const PHOTO_BUCKET = "member-photos";
export const PAYMENT_BUCKET = "payment-screenshots";

// In-memory cache so we don't re-sign on every render.
const signedUrlCache = new Map<string, { url: string; expires: number }>();

/**
 * Resolve a storage path to a signed URL using the authenticated session.
 * Full http(s) URLs are returned as-is. The bucket defaults to member-photos
 * for backward compatibility.
 */
export async function resolveStorageUrlAsync(
  path: string | null | undefined,
  bucket: string = PHOTO_BUCKET,
): Promise<string | null> {
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;

  const cacheKey = `${bucket}::${path}`;
  const now = Date.now();
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expires > now + 30_000) return cached.url;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 60); // 1h
  if (error || !data?.signedUrl) return null;

  signedUrlCache.set(cacheKey, { url: data.signedUrl, expires: now + 60 * 60 * 1000 });
  return data.signedUrl;
}

/** Back-compat alias. */
export async function resolvePhotoUrlAsync(
  photo: string | null | undefined,
): Promise<string | null> {
  return resolveStorageUrlAsync(photo, PHOTO_BUCKET);
}

/** Fetch any storage object as a base64 data URL — required for clean canvas
 *  embedding without CORS tainting. */
export async function fetchStorageAsDataUrl(
  path: string | null | undefined,
  bucket: string = PHOTO_BUCKET,
): Promise<string | null> {
  const url = await resolveStorageUrlAsync(path, bucket);
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
