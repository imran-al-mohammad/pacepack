-- ─────────────────────────────────────────────────────────────
-- Certificate Feature — PacePack
-- Adds certificate_url to registrations + user_certificates table
-- ─────────────────────────────────────────────────────────────

-- 1) Add certificate_url column to registrations (if not exists)
ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS certificate_url TEXT;

-- 2) Create user_certificates table
CREATE TABLE IF NOT EXISTS public.user_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id UUID NOT NULL REFERENCES public.runners(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  marathon_id UUID REFERENCES public.marathons(id) ON DELETE SET NULL,
  marathon_name TEXT,
  race_date DATE,
  distance TEXT,
  finish_time TEXT,
  place_overall TEXT,
  certificate_url TEXT,
  issued_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3) Indexes
CREATE INDEX IF NOT EXISTS idx_user_certificates_runner ON public.user_certificates(runner_id);
CREATE INDEX IF NOT EXISTS idx_user_certificates_group ON public.user_certificates(group_id);

-- 4) Enable RLS
ALTER TABLE public.user_certificates ENABLE ROW LEVEL SECURITY;

-- 5) RLS policies
CREATE POLICY "Members can view certificates" ON public.user_certificates
  FOR SELECT USING (
    auth.uid() IN (
      SELECT user_id FROM public.group_memberships WHERE group_id = user_certificates.group_id
    )
  );

CREATE POLICY "Members can insert certificates" ON public.user_certificates
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM public.group_memberships WHERE group_id = user_certificates.group_id
    )
  );

CREATE POLICY "Moderators can update certificates" ON public.user_certificates
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT user_id FROM public.group_memberships
      WHERE group_id = user_certificates.group_id AND role IN ('moderator', 'admin')
    )
  );

CREATE POLICY "Moderators can delete certificates" ON public.user_certificates
  FOR DELETE USING (
    auth.uid() IN (
      SELECT user_id FROM public.group_memberships
      WHERE group_id = user_certificates.group_id AND role IN ('moderator', 'admin')
    )
  );

-- 6) Function: auto-issue a certificate when a result is completed
CREATE OR REPLACE FUNCTION public.issue_certificate_for_result()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.status = 'completed' OR NEW.chip_time IS NOT NULL OR NEW.gun_time IS NOT NULL) THEN
    INSERT INTO public.user_certificates (
      runner_id,
      group_id,
      marathon_id,
      marathon_name,
      race_date,
      distance,
      finish_time,
      place_overall,
      certificate_url,
      issued_at
    )
    SELECT
      NEW.runner_id,
      NEW.group_id,
      NEW.marathon_id,
      m.name,
      m.race_date,
      COALESCE(NEW.race_distance, m.distance),
      COALESCE(NEW.chip_time, NEW.gun_time),
      NEW.place_overall,
      NEW.certificate_url,
      now()
    FROM public.marathons m
    WHERE m.id = NEW.marathon_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7) Trigger on registrations when result data is updated
DROP TRIGGER IF EXISTS trg_issue_certificate ON public.registrations;
CREATE TRIGGER trg_issue_certificate
  AFTER INSERT OR UPDATE OF status, chip_time, gun_time, race_distance, place_overall, certificate_url
  ON public.registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.issue_certificate_for_result();