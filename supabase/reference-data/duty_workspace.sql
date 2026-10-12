-- Required singleton for atomic revision checks; contains no user or schedule data.
INSERT INTO public.duty_workspace(id,revision) VALUES (true,0);
