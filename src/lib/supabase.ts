import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cnwchucuzheqpzoyuybi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNud2NodWN1emhlcXB6b3l1eWJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1OTgwMzQsImV4cCI6MjA5MjE3NDAzNH0.0ztpxH6-V6TVf96hP46DcFmPKnw7GKcC_Xpf7uk_Iso";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const PHOTO_BUCKET = "member-photos";

export function resolvePhotoUrl(photo: string | null | undefined): string | null {
  if (!photo) return null;
  if (photo.startsWith("http://") || photo.startsWith("https://")) return photo;
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(photo);
  return data.publicUrl;
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
