-- Dar acceso al pipeline al rol `authenticated`.
--
-- Scout ya no opera como `anon`: desde el login con Supabase Auth
-- (signInWithPassword) todas las peticiones viajan con el access_token del
-- usuario, es decir con rol `authenticated`.
--
-- `wm_pipeline` tiene RLS activado y su unica politica (`anon_all_pipeline`)
-- esta declarada `to anon`, asi que un usuario identificado NO la cumple: sin
-- esta migracion el pipeline (drag&drop, MRR, KPIs) dejaria de leer y guardar
-- en cuanto Scout se autentica.
--
-- Se anade la politica equivalente para `authenticated`. La de `anon` se deja
-- intacta a proposito: se retirara aparte, junto con el cierre de leads_web.

drop policy if exists "authenticated_all_pipeline" on public.wm_pipeline;
create policy "authenticated_all_pipeline"
  on public.wm_pipeline
  for all
  to authenticated
  using (true)
  with check (true);
