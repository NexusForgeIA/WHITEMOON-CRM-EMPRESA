-- Scout captación: columna de teléfono móvil
alter table public.wm_captacion add column if not exists telefono text default '';
