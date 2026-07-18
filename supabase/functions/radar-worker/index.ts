import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const AUDIT_ENDPOINT = 'https://whitemoon-seo-geo-ia.onrender.com/audit-json';
const RADAR_TOKEN = Deno.env.get('RADAR_TOKEN') ?? '';

const REST_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
};

function calcularDolor(score: number | null, senales: any, nResenas: number | null): number {
  if (senales && senales.sin_web) return 100;
  let d = 100 - (typeof score === 'number' ? Math.min(Math.max(score, 0), 100) : 50);
  if (senales) {
    if (senales.sin_chatbot) d += 15;
    if (senales.sin_ssl) d += 10;
    if (senales.sin_gbp_web) d += 10;
  }
  if (typeof nResenas === 'number' && nResenas < 10) d += 5;
  return Math.min(Math.max(Math.round(d), 0), 100);
}

function senalPrincipal(senales: any, score: number | null): string {
  if (senales?.sin_web) return 'no encontramos web activa';
  if (senales?.sin_ssl) return 'la web aparece como "no segura" en el navegador de vuestros clientes';
  if (senales?.sin_chatbot) return 'nadie atiende a quien entra en la web fuera de horario';
  if (typeof score === 'number' && score < 50) return 'la web es practicamente invisible en Google y en los buscadores de IA';
  return 'hay mejoras claras de visibilidad con impacto directo en clientes nuevos';
}

// Speech de contacto (v2, basado en el de Cris 09/07):
// - Datos reales del prospecto rellenados automaticamente (rating, resenas, score)
// - Marcador 📎 para las capturas Google/ChatGPT: verificacion MANUAL de Cris antes de enviar
//
// NOTA: para prospectos SIN web, Scout (pestaña Radar) genera y ENVIA una plantilla
// "Pack Mini Core" desde el cliente vía el parametro `mensaje` de la accion `aprobar`
// (ver index.html). generarMensaje() sigue siendo el fallback del servidor si el
// cliente no manda texto.
function generarMensaje(p: any): string {
  const capturas = '\n\n📎 [ANTES DE ENVIAR: busca su sector en Google y pregunta a ChatGPT por "' + p.sector + ' en ' + p.zona + '", haz capturas donde no aparecen y adjuntalas — borra esta linea]';
  const cierre = ' Os preparamos una auditoria gratuita (2 paginas, sin compromiso) para que sepais donde estais y donde podeis llegar. ¿Os la paso por aqui?';

  if (p.senales?.sin_web) {
    return `Buenas, os escribimos de WhiteMoon Agencia IA, en Majadahonda. Buscando ${p.sector} en ${p.zona} hemos visto que ${p.nombre} no tiene web activa: para el cliente nuevo que busca en Google o pregunta a una IA, hoy no existis — y ese cliente acaba en la competencia.${cierre}${capturas}`;
  }

  const tieneReputacion = typeof p.rating === 'number' && p.rating >= 4.5 && typeof p.n_resenas === 'number' && p.n_resenas >= 30;
  if (tieneReputacion) {
    return `Buenas, os escribimos de WhiteMoon Agencia IA, en Majadahonda. Hemos analizado la presencia online de ${p.nombre}: teneis ${p.rating}⭐ y ${p.n_resenas} reseñas — de los mejor valorados de ${p.zona} — pero vuestra web puntua ${p.score_auditoria}/100 en visibilidad, y al buscar ${p.sector} en ${p.zona} en Google y en ChatGPT no os encuentra el paciente nuevo. Teneis lo dificil hecho; os falta que se os vea.${cierre}${capturas}`;
  }

  return `Buenas, os escribimos de WhiteMoon Agencia IA, en Majadahonda. Hemos analizado la presencia online de ${p.nombre}: puntua ${p.score_auditoria}/100 y ${senalPrincipal(p.senales, p.score_auditoria)}. Si el cliente nuevo que busca ${p.sector} en ${p.zona} no os encuentra, elige a otro.${cierre}${capturas}`;
}

Deno.serve(async (req: Request) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'encolar') {
      const sector = String(body.sector || '').slice(0, 60).trim();
      const zona = String(body.zona || '').slice(0, 60).trim();
      const negocios = Array.isArray(body.negocios) ? body.negocios.slice(0, 30) : [];
      if (!sector || !zona || negocios.length === 0) return json({ error: 'sector, zona y negocios[] obligatorios' }, 400);

      let nuevos = 0, sinWeb = 0, duplicados = 0;
      for (const n of negocios) {
        const placeId = String(n.place_id || '').slice(0, 200);
        const nombre = String(n.nombre || '').slice(0, 160).trim();
        if (!placeId || !nombre) continue;
        const web = n.web ? String(n.web).slice(0, 300) : null;
        const fila: Record<string, unknown> = {
          place_id: placeId, nombre, sector, zona, web,
          telefono: n.telefono ? String(n.telefono).slice(0, 30) : null,
          rating: typeof n.rating === 'number' ? n.rating : null,
          n_resenas: typeof n.n_resenas === 'number' ? n.n_resenas : null,
        };
        if (!web) {
          fila.estado = 'analizado';
          fila.senales = { sin_web: true };
          fila.dolor = 100;
          fila.analizado_at = new Date().toISOString();
        }
        const r = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar`, {
          method: 'POST',
          headers: { ...REST_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify(fila),
        });
        if (r.status === 201) { nuevos++; if (!web) sinWeb++; }
        else duplicados++;
      }
      return json({ ok: true, nuevos, sin_web: sinWeb, duplicados });
    }

    if (action === 'procesar') {
      const max = Math.min(Math.max(parseInt(body.max, 10) || 3, 1), 5);
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?estado=eq.pendiente&intentos=lt.2&select=id,nombre,web,n_resenas&order=created_at.asc&limit=${max}`, { headers: REST_HEADERS });
      const pendientes = await pr.json();
      if (!Array.isArray(pendientes) || pendientes.length === 0) return json({ ok: true, procesados: 0, mensaje: 'sin pendientes' });

      const auditHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (RADAR_TOKEN) auditHeaders['X-Radar-Token'] = RADAR_TOKEN;

      const resultados: any[] = [];
      for (const p of pendientes) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          const ar = await fetch(AUDIT_ENDPOINT, {
            method: 'POST',
            headers: auditHeaders,
            body: JSON.stringify({ url: p.web }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!ar.ok) throw new Error(`audit HTTP ${ar.status}`);
          const audit = await ar.json();
          if (audit.ok === false) throw new Error(String(audit.error || 'audit fallo suave'));
          const score = typeof audit.score === 'number' ? Math.round(audit.score) : null;
          const senales = (audit.senales && typeof audit.senales === 'object') ? audit.senales : {};
          const dolor = calcularDolor(score, senales, p.n_resenas);
          await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${p.id}`, {
            method: 'PATCH', headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ score_auditoria: score, senales, dolor, estado: 'analizado', analizado_at: new Date().toISOString() }),
          });
          resultados.push({ nombre: p.nombre, dolor, score });
        } catch (e) {
          const gr = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${p.id}&select=intentos`, { headers: REST_HEADERS });
          const gRows = await gr.json();
          const intentos = (Array.isArray(gRows) && gRows[0] ? gRows[0].intentos : 0) + 1;
          await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${p.id}`, {
            method: 'PATCH', headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ intentos, estado: intentos >= 2 ? 'error' : 'pendiente' }),
          });
          resultados.push({ nombre: p.nombre, error: String(e).slice(0, 120), intentos });
        }
      }
      return json({ ok: true, procesados: resultados.length, resultados });
    }

    if (action === 'list') {
      const filtros: string[] = [];
      if (body.sector) filtros.push(`sector=eq.${encodeURIComponent(String(body.sector))}`);
      if (body.zona) filtros.push(`zona=eq.${encodeURIComponent(String(body.zona))}`);
      if (body.estado) filtros.push(`estado=eq.${encodeURIComponent(String(body.estado))}`);
      const q = filtros.length ? '&' + filtros.join('&') : '';
      const r = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?select=id,nombre,sector,zona,web,telefono,rating,n_resenas,score_auditoria,senales,dolor,estado,intentos,created_at,analizado_at${q}&order=dolor.desc.nullslast,created_at.desc&limit=200`, { headers: REST_HEADERS });
      const rows = await r.json();
      const pend = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?estado=eq.pendiente&select=id`, { headers: REST_HEADERS });
      const pRows = await pend.json();
      return json({ ok: true, prospectos: Array.isArray(rows) ? rows : [], pendientes: Array.isArray(pRows) ? pRows.length : 0 });
    }

    if (action === 'aprobar') {
      const id = String(body.id || '');
      if (!id) return json({ error: 'id obligatorio' }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${encodeURIComponent(id)}&select=*`, { headers: REST_HEADERS });
      const rows = await r.json();
      const p = Array.isArray(rows) ? rows[0] : null;
      if (!p) return json({ error: 'prospecto no encontrado' }, 404);
      if (p.estado === 'en_pipeline') return json({ ok: false, reason: 'ya esta en el pipeline' });

      // El cliente (Radar) puede mandar la plantilla ya elegida y rellenada
      // (p. ej. "Pack Mini Core" para prospectos sin web). Si no la manda,
      // generarMensaje() sigue siendo el fallback del servidor.
      const override = typeof body.mensaje === 'string' ? body.mensaje.trim().slice(0, 1500) : '';
      const mensaje = override || generarMensaje(p);
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/leads_web`, {
        method: 'POST', headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          nombre: p.nombre,
          telefono: p.telefono || '',
          sector: p.sector,
          interes: 'radar',
          origen: 'radar-' + p.zona.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          mensaje,
        }),
      });
      const lRows = await ins.json();
      if (!Array.isArray(lRows) || !lRows[0]) return json({ error: 'no se pudo crear el lead en Scout' }, 500);
      await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ estado: 'en_pipeline', mensaje }),
      });
      return json({ ok: true, lead_id: lRows[0].id, mensaje });
    }

    if (action === 'descartar') {
      const id = String(body.id || '');
      if (!id) return json({ error: 'id obligatorio' }, 400);
      await fetch(`${SUPABASE_URL}/rest/v1/prospectos_radar?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ estado: 'descartado' }),
      });
      return json({ ok: true });
    }

    return json({ error: 'action debe ser encolar, procesar, list, aprobar o descartar' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
