-- Permitir que el rol `anon` borre filas de leads_web.
--
-- El Scout CRM opera siempre como rol `anon` (login propio contra la tabla
-- `users`, sin sesion de Supabase Auth). El frontend ya ofrece un boton de
-- eliminar lead (lwDeleteLead -> from('leads_web').delete()), pero sin una
-- politica de DELETE para anon la operacion no surtia efecto.
--
-- Se anade DELETE para anon, en linea con la politica de INSERT ya existente
-- ("Allow anonymous inserts") y con el resto de tablas del CRM (wm_pipeline
-- concede ALL a anon).

grant delete on public.leads_web to anon;

drop policy if exists "Allow anon deletes" on public.leads_web;
create policy "Allow anon deletes"
  on public.leads_web
  for delete
  to anon
  using (true);
