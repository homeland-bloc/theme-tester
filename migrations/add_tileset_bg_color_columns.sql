-- Fix 3C: Add nullable background colour columns to tilesets table
-- Run this in the Supabase SQL editor or via psql.
-- These columns are backfilled manually after running the Extract Atlas BG Colours tool.

ALTER TABLE tilesets
  ADD COLUMN IF NOT EXISTS bg_color_light text,
  ADD COLUMN IF NOT EXISTS bg_color_dark  text;
