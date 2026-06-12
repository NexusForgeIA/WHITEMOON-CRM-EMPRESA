-- Leads Web no aparecían en el Scout CRM.
--
-- Causa: el frontend (index.html) usa SIEMPRE el rol `anon` — el login es una
-- comprobación propia contra la tabla `users` y nunca abre sesión de Supabase
-- Auth, por lo que el cliente nunca asume el rol `authenticated`.
--
-- La tabla `leads_web` permitía INSERT a `anon` (para que el chatbot/voz de
-- whitemoon.es escriba leads) pero su política de SELECT estaba limitada a
-- `authenticated`, un rol que la app no llega a tener. Resultado: la consulta
-- `select('*')` devolvía 0 filas y ningún lead web se mostraba (incluido el de
-- origen LUNA-VOZ-WEB).
--
-- Resto de tablas del CRM (`users`, `wm_pipeline`) ya conceden acceso a `anon`.
-- Esta migración alinea `leads_web` con ese mismo patrón añadiendo SELECT anon.

grant select on public.leads_web to anon;

drop policy if exists "Allow anon reads" on public.leads_web;
create policy "Allow anon reads"
  on public.leads_web
  for select
  to anon
  using (true);
