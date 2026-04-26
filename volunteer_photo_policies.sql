-- =====================================================================
-- Grant volunteers read access to the member-photos storage bucket
-- Run this in your Supabase SQL Editor
-- =====================================================================

DROP POLICY IF EXISTS "staff reads member photos" ON storage.objects;
CREATE POLICY "staff reads member photos"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'member-photos'
    AND (
      public.has_role(auth.uid(), 'admin') OR
      public.has_role(auth.uid(), 'volunteer')
    )
  );
