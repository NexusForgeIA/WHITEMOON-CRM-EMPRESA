-- Scout captación: columna web
alter table public.wm_captacion add column if not exists web text default '';
