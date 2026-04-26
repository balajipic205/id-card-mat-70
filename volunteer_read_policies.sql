-- =====================================================================
-- Grant volunteers read access to members and teams tables
-- Run this in your Supabase SQL Editor
-- =====================================================================

-- 1. Allow volunteers to read from the teams table
DROP POLICY IF EXISTS "teams volunteer read" ON public.teams;
CREATE POLICY "teams volunteer read" ON public.teams
  FOR SELECT 
  USING (public.has_role(auth.uid(), 'volunteer'));

-- 2. Allow volunteers to read from the members table
DROP POLICY IF EXISTS "members volunteer read" ON public.members;
CREATE POLICY "members volunteer read" ON public.members
  FOR SELECT 
  USING (public.has_role(auth.uid(), 'volunteer'));
