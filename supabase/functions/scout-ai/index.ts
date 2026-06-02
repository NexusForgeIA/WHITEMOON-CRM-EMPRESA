// ════════════════════════════════════════════════════════════════
// scout-ai · Edge Function (Supabase / Deno)
// Asistente IA central del Scout CRM de WhiteMoon.
// Recibe { module, action, context } y llama a la Claude API.
//
// La API key de Anthropic vive SOLO en el servidor:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// Nunca se expone en el frontend.
// ════════════════════════════════════════════════════════════════
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Variables de entorno inyectadas automáticamente por Supabase en el runtime.
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Precios de los packs de cliente WhiteMoon (NO son los precios de Scout).
const WM_PACK_PRICE: Record<string, number> = {
  spark: 199,
  core: 199,
  scale: 449,
  elite: 599,
};

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

// ── Contexto común de marca ──────────────────────────────────────
const BRAND = `WhiteMoon es una agencia española que implanta agentes de IA (chatbots) y soluciones digitales para negocios locales (clínicas dentales, restaurantes, despachos legales, gestorías, talleres, inmobiliarias, etc.).
"Orion IA" es el agente conversacional de IA que WhiteMoon despliega para sus clientes.
Escribe SIEMPRE en español de España, tono profesional pero cercano, tratando de "tú". Sé concreto y comercial, evita relleno y promesas que no se puedan cumplir. Plazos de entrega: "5-7 días laborables".`;

const clean = (v: unknown) => (v == null ? "" : String(v)).trim();

// ── Construcción del prompt por módulo/acción (modos JSON one-shot) ─
function buildRequest(
  module: string,
  action: string,
  ctx: Record<string, unknown>,
): { system: string; user: string; json: boolean; maxTokens: number } {
  switch (module) {
    // ── LEADS: analizar un lead entrante ───────────────────────────
    case "leads": {
      const system =
        `${BRAND}\n\nEres un SDR experto en cualificación de leads. Analizas leads que llegan desde la web/chatbot de WhiteMoon y de sus clientes.\n` +
        `Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin markdown, sin texto extra) con esta forma exacta:\n` +
        `{"intencion":"alta|media|baja","intencion_motivo":"1 frase justificando la intención","mensaje_whatsapp":"mensaje de WhatsApp listo para enviar, cercano y personalizado, máx 65 palabras, con un único CTA","siguiente_accion":"acción comercial concreta recomendada, 1 frase"}`;
      const user =
        `Analiza este lead:\n` +
        `- Nombre: ${clean(ctx.nombre) || "(desconocido)"}\n` +
        `- Empresa: ${clean(ctx.empresa) || "(desconocida)"}\n` +
        `- Sector: ${clean(ctx.sector) || "(desconocido)"}\n` +
        `- Origen: ${clean(ctx.origen) || "(desconocido)"}\n` +
        `- Mensaje/interés: ${clean(ctx.mensaje) || "(sin mensaje)"}`;
      return { system, user, json: true, maxTokens: 700 };
    }

    // ── ONBOARDING: generar system prompt de Orion IA ──────────────
    case "onboarding": {
      const system =
        `${BRAND}\n\nEres un experto en diseño de agentes conversacionales. Generas el SYSTEM PROMPT completo y listo para producción del agente "Orion IA" de un cliente concreto de WhiteMoon.\n` +
        `El system prompt debe estar escrito en español, en segunda persona dirigida al agente ("Eres Orion IA..."), e incluir: identidad y rol, tono de voz, objetivos (captar/cualificar/agendar), qué datos recoge, qué NO debe hacer (no inventar precios ni diagnósticos, derivar a humano cuando proceda), y estilo de respuesta (breve, una pregunta a la vez).\n` +
        `Devuelve ÚNICAMENTE el texto del system prompt, sin comentarios, sin markdown, sin comillas envolventes.`;
      const user =
        `Genera el system prompt de Orion IA para este cliente:\n` +
        `- Nombre del cliente/negocio: ${clean(ctx.cliente_nombre) || "(sin nombre)"}\n` +
        `- Sector: ${clean(ctx.sector) || "(genérico)"}\n` +
        `- Pack contratado: ${clean(ctx.pack) || "(no especificado)"}\n` +
        `- Web del cliente: ${clean(ctx.url_web_cliente) || "(sin web)"}`;
      return { system, user, json: false, maxTokens: 1400 };
    }

    // ── CAMPAÑAS: generar 3 creatividades (Meta + Google) ──────────
    case "campaigns": {
      const system =
        `${BRAND}\n\nEres un copywriter de paid media senior. Aplicas estos frameworks:\n` +
        `ÁNGULOS (elige uno distinto por variante): punto de dolor, resultado, prueba social, curiosidad, comparación, urgencia, identidad, contrario.\n` +
        `REGLAS DE CREATIVIDAD: específico mejor que vago (usa números/plazos); beneficios antes que características; voz activa; sin jerga ni superlativos sin prueba; sin MAYÚSCULAS ni puntuación excesiva; no prometas lo que la landing no cumple; el CTA claro.\n` +
        `LÍMITES META: texto principal con el gancho en los primeros ~125 caracteres; titular ≤40; descripción ≤30.\n` +
        `LÍMITES GOOGLE RSA: cada titular ≤30 (deben funcionar por separado y combinados); cada descripción ≤90; incluye al menos un titular con keyword, uno con beneficio y uno con CTA.\n` +
        `Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin markdown) con esta forma exacta:\n` +
        `{"variantes":[{"nombre":"etiqueta corta","angulo":"nombre del ángulo","meta":{"texto_principal":"...","titular":"...","descripcion":"..."},"google":{"titulares":["t1","t2","t3"],"descripciones":["d1","d2"]}}]}\n` +
        `Genera EXACTAMENTE 3 variantes, cada una con un ángulo distinto. Respeta los límites de caracteres.`;
      const user =
        `Genera 3 creatividades para esta campaña:\n` +
        `- Sector del negocio: ${clean(ctx.sector) || "(genérico)"}\n` +
        `- Pack/servicio a promocionar: ${clean(ctx.pack) || "agente IA WhiteMoon"}\n` +
        `- Objetivo de campaña: ${clean(ctx.objetivo) || "conversión"}`;
      return { system, user, json: true, maxTokens: 1600 };
    }

    // ── PIPELINE: sugerir siguiente acción de venta ────────────────
    case "pipeline": {
      const system =
        `${BRAND}\n\nEres un director comercial. Para un deal del pipeline, recomiendas la siguiente acción de venta MÁS efectiva según su estado y su sector.\n` +
        `Estados del pipeline: pending (sin contactar), contacted (contactado), demo (demo enviada), proposal (propuesta enviada), negotiating (negociando), won (cerrado), lost (perdido).\n` +
        `Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin markdown) con esta forma exacta:\n` +
        `{"siguiente_accion":"acción concreta a ejecutar, 1 frase accionable","motivo":"por qué es la mejor jugada ahora, 1 frase","mensaje":"mensaje breve (WhatsApp/email) listo para enviar al prospecto, máx 60 palabras"}`;
      const user =
        `Recomienda la siguiente acción para este deal:\n` +
        `- Nombre/negocio: ${clean(ctx.name) || clean(ctx.domain) || "(desconocido)"}\n` +
        `- Sector: ${clean(ctx.sector) || "(desconocido)"}\n` +
        `- Estado actual: ${clean(ctx.estado) || clean(ctx.status) || "pending"}\n` +
        `- MRR potencial: ${clean(ctx.mrr) || "0"}€/mes\n` +
        `- Último contacto: ${clean(ctx.lastContact) || "(sin registro)"}\n` +
        `- Notas: ${clean(ctx.notes) || "(sin notas)"}`;
      return { system, user, json: true, maxTokens: 600 };
    }

    default:
      throw new Error(`Módulo no soportado: ${module}`);
  }
}

function extractJSON(text: string): unknown {
  let t = text.trim();
  // quita vallas de código ```json ... ```
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch (_) { /* cae al return de abajo */ }
    }
    return null;
  }
}

// ── Texto a partir de la respuesta de Claude (bloques type:text) ──
function textFromClaude(aiJson: unknown): string {
  const content = (aiJson as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string }) => b && b.type === "text")
    .map((b: { text?: string }) => b.text || "")
    .join("\n")
    .trim();
}

// ════════════════════════════════════════════════════════════════
// ASISTENTE IA — chat conversacional con contexto y herramientas
// ════════════════════════════════════════════════════════════════

// Detecta URLs http(s) en un texto.
function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"')]+/gi;
  const found = text.match(re) || [];
  // de-dup conservando orden
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, "")))];
}

// Descarga una URL server-side, limpia el HTML y trunca el texto.
async function fetchUrlText(
  url: string,
  maxChars = 9000,
): Promise<{ ok: boolean; text: string; status?: number; error?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; WhiteMoonScout/1.0; +https://whitemoon.es)",
        "accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, text: "", status: resp.status };
    const raw = await resp.text();
    const cleaned = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { ok: true, text: cleaned.slice(0, maxChars) };
  } catch (e) {
    return { ok: false, text: "", error: String((e as Error).message) };
  }
}

// Lee datos reales de Supabase para inyectar contexto de negocio.
async function loadBusinessContext(): Promise<string> {
  if (!SB_URL || !SB_SERVICE_KEY) {
    return "(Contexto de negocio no disponible: faltan credenciales de Supabase en el servidor.)";
  }
  const headers = {
    apikey: SB_SERVICE_KEY,
    authorization: `Bearer ${SB_SERVICE_KEY}`,
  };
  try {
    const [obResp, leadsResp] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/onboarding_clientes?select=estado,pack,cliente_nombre`, { headers }),
      fetch(`${SB_URL}/rest/v1/leads_web?select=atendido,created_at,sector`, { headers }),
    ]);
    const ob: Array<Record<string, unknown>> = obResp.ok ? await obResp.json() : [];
    const leads: Array<Record<string, unknown>> = leadsResp.ok ? await leadsResp.json() : [];

    const completados = ob.filter((r) => r.estado === "completado");
    const enOnboarding = ob.filter((r) =>
      r.estado !== "completado" && r.estado !== "pausado"
    );
    const mrr = completados.reduce(
      (sum, r) => sum + (WM_PACK_PRICE[String(r.pack)] || 0),
      0,
    );
    const pendientes = leads.filter((l) => l.atendido !== true);
    const weekAgo = Date.now() - 7 * 86400000;
    const leadsSemana = leads.filter((l) => {
      const c = l.created_at ? new Date(String(l.created_at)).getTime() : 0;
      return c >= weekAgo;
    });

    return [
      `DATOS REALES DE WHITEMOON (en vivo, ${new Date().toISOString().slice(0, 10)}):`,
      `- Clientes activos (onboarding completado): ${completados.length}`,
      `- Clientes en onboarding en curso: ${enOnboarding.length}`,
      `- MRR actual estimado: ${mrr}€/mes`,
      `- Leads totales en BD: ${leads.length}`,
      `- Leads pendientes (sin atender): ${pendientes.length}`,
      `- Leads de los últimos 7 días: ${leadsSemana.length}`,
    ].join("\n");
  } catch (e) {
    return `(No se pudo cargar el contexto de negocio: ${String((e as Error).message)})`;
  }
}

const ASSISTANT_SYSTEM = `${BRAND}

Eres el ASISTENTE IA central del Scout CRM de WhiteMoon: el copiloto comercial de Cristóbal (fundador). Ayudas a captar clientes, gestionar el pipeline y producir todo el material comercial de la agencia. Eres resolutivo, directo y orientado a la acción.

PRECIOS DE CLIENTE WhiteMoon (los que vende la agencia a negocios locales; NO menciones precios de "Scout"):
- Pack Spark: 499€ setup + 199€/mes (sin permanencia)
- Pack Core: 1.800€ setup + 199€/mes
- Pack Scale: 4.500€ setup + 449€/mes
- Pack Elite: 8.500€ setup + 599€/mes
Plazo de entrega siempre "5-7 días laborables".

CAPACIDADES (ejecútalas cuando te las pidan):
1. CAMPAÑAS Meta Ads / Google Ads: genera campaña completa (ángulo, creatividades, copy, segmentación y presupuesto sugerido). Aplica buenas prácticas de ad-creative: un ángulo claro por variante (dolor, resultado, prueba social, curiosidad, urgencia, identidad); específico mejor que vago (números y plazos); beneficios antes que características; voz activa; CTA claro; respeta límites (Meta: gancho en ~125 car., titular ≤40; Google RSA: titulares ≤30, descripciones ≤90).
2. PROPUESTAS / PRESENTACIONES: genera la propuesta completa en HTML autocontenido listo para imprimir o enviar (precios WhiteMoon, beneficios, ROI estimado y casos de uso del sector).
3. EMAILS y WHATSAPP: mensajes personalizados por sector con estructura AIDA (atención, interés, deseo, acción), listos para copiar.
4. ANÁLISIS DE PIPELINE: usa los DATOS REALES inyectados abajo para responder (leads de la semana, MRR, conversiones, próximos vencimientos) con un análisis accionable.
5. SYSTEM PROMPTS de Orion IA: genera el system prompt completo del agente para un sector/cliente, listo para pegar en el panel CDN.
6. CREACIÓN DE WEBS / LANDINGS: genera HTML/CSS/JS completo en un solo archivo, sin frameworks (stack WhiteMoon), con copy persuasivo y formulario de captación de leads.
7. ANÁLISIS DE WEBS: cuando te pasen una URL, recibirás su contenido ya extraído. Evalúa SEO, velocidad aparente, si tiene chatbot, formularios y oportunidades de IA. Devuelve una puntuación 0-100 y recomendaciones, e indica si es cliente potencial para WhiteMoon.
8. PROSPECCIÓN: usa la búsqueda web para encontrar negocios por sector y ciudad, analiza sus webs y devuelve una lista (nombre, web, teléfono, oportunidad detectada) con un mensaje de contacto personalizado por cada uno.
9. EXTRACCIÓN ESTILO GOOGLE MAPS: busca negocios por sector y ciudad con la búsqueda web; extrae nombre, dirección, teléfono, web, valoración y nº de reseñas si están disponibles; detecta si tienen chatbot; clasifica la oportunidad (SIN WEB = alta, CON WEB SIN CHATBOT = media, CON CHATBOT = descartado); añade un mensaje de WhatsApp por prospecto. Devuelve los prospectos en el BLOQUE JSON de prospección descrito abajo (no en tabla markdown). Avisa de que los datos hay que verificarlos.
10. INFORMES SEMANALES: consolida leads de la semana, MRR, pipeline, campañas y onboarding en un informe; ofrécelo también en HTML imprimible si te lo piden.
11. ANÁLISIS DE COMPETENCIA: con búsqueda web, compara agencias de IA (servicios, precios, posicionamiento) y sugiere diferenciadores para WhiteMoon.

FORMATO DE RESPUESTA:
- Responde SIEMPRE en markdown bien estructurado (títulos, listas, tablas, **negritas**, bloques de código).
- Cuando generes HTML (webs, propuestas, informes), entrégalo dentro de un bloque de código \`\`\`html para que se pueda copiar de una vez.
- Sé conciso por defecto; extiéndete solo cuando el entregable lo requiera.
- Si usas la búsqueda web, indica que los datos de contacto deben verificarse antes de usarlos.
- No inventes datos de clientes: usa solo los DATOS REALES inyectados; si faltan, dilo.

PROSPECCIÓN — BLOQUE JSON OBLIGATORIO (capacidades 8 y 9):
Cuando hagas prospección o extracción estilo Google Maps, NO uses una tabla markdown para listar los negocios. En su lugar, añade SIEMPRE al final de tu respuesta UN ÚNICO bloque de código \`\`\`json con esta forma exacta para que la interfaz lo pinte como tarjetas:
\`\`\`json
{"type":"prospects","data":[{"nombre":"","telefono":"","web":"","puntuacion":"","resenas":0,"chatbot":false,"oportunidad":"","direccion":"","sector":"","mensaje_wa":""}]}
\`\`\`
Reglas del JSON:
- "oportunidad": una de "alta" (sin web), "media" (con web sin chatbot), "baja" o "descartado" (con chatbot).
- "chatbot": booleano true/false (si el negocio ya tiene un chatbot/agente IA en su web).
- "web": URL del negocio, o cadena vacía "" si no tiene web.
- "puntuacion": valoración Google como cadena (ej. "4.8") o "" si no consta. "resenas": número de reseñas (entero) o 0.
- "telefono": teléfono en formato legible (ej. "+34 600 123 456") o "" si no consta.
- "mensaje_wa": mensaje de WhatsApp personalizado para ese prospecto (máx ~60 palabras, tono cercano, un único CTA).
- "sector" y "direccion": cadenas; usa "" si no aplica.
- Incluye en "data" TODOS los prospectos encontrados.
Puedes acompañar el JSON con un breve texto introductorio antes del bloque (por ejemplo, cuántos negocios has encontrado y el recordatorio de verificar los datos), pero los datos de cada negocio deben ir SOLO en el JSON, no duplicados en una tabla.`;

// Llama a Claude. Si falla por las herramientas, reintenta sin ellas.
async function callClaudeChat(
  system: { type: string; text: string; cache_control?: { type: string } }[],
  messages: { role: string; content: string }[],
  maxTokens: number,
  withTools: boolean,
): Promise<{ ok: true; aiJson: unknown } | { ok: false; status: number; detail: string }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (withTools) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  }
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (resp.ok) return { ok: true, aiJson: await resp.json() };
  const detail = await resp.text();
  // Si el error parece deberse a la herramienta web_search, reintenta sin ella.
  if (withTools && (resp.status === 400 || resp.status === 404) &&
      /tool|web_search|not.*support|unsupported/i.test(detail)) {
    return await callClaudeChat(system, messages, maxTokens, false);
  }
  return { ok: false, status: resp.status, detail };
}

async function handleAsistente(
  ctx: Record<string, unknown>,
): Promise<Response> {
  // Historial de conversación: [{role:'user'|'assistant', content:'...'}]
  const rawMsgs = Array.isArray(ctx.messages) ? ctx.messages : [];
  const mapped = rawMsgs
    .map((m) => {
      const role = (m && (m as Record<string, unknown>).role) === "assistant"
        ? "assistant"
        : "user";
      const content = clean((m as Record<string, unknown>).content);
      return { role, content };
    })
    .filter((m) => m.content.length > 0)
    .slice(-20); // limita el historial enviado

  // La API de Claude exige que el primer turno sea de 'user' y que los roles
  // se alternen. Normaliza: descarta 'assistant' iniciales y fusiona turnos
  // consecutivos del mismo rol.
  const messages: { role: string; content: string }[] = [];
  for (const m of mapped) {
    if (!messages.length && m.role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) {
      last.content += "\n\n" + m.content;
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  if (!messages.length) {
    return json({ ok: false, error: "No hay mensajes en la conversación" }, 400);
  }

  // Contexto de negocio en vivo desde Supabase.
  const businessCtx = await loadBusinessContext();

  // Si el último mensaje del usuario contiene URLs, descárgalas server-side.
  let urlBlock = "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    const urls = extractUrls(lastUser.content).slice(0, 2);
    for (const u of urls) {
      const r = await fetchUrlText(u);
      if (r.ok && r.text) {
        urlBlock += `\n\nCONTENIDO EXTRAÍDO DE ${u} (texto del HTML, truncado):\n"""${r.text}"""`;
      } else {
        urlBlock += `\n\nNo se pudo descargar ${u}${r.status ? ` (HTTP ${r.status})` : ""}. Indícaselo al usuario.`;
      }
    }
  }

  const systemText = `${ASSISTANT_SYSTEM}\n\n${businessCtx}${urlBlock}`;

  const result = await callClaudeChat(
    [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages,
    4096,
    true,
  );

  if (!result.ok) {
    return json(
      { ok: false, error: "Claude API " + result.status, detail: result.detail },
      502,
    );
  }

  const reply = textFromClaude(result.aiJson);
  if (!reply) {
    return json({ ok: false, error: "La IA no devolvió respuesta" }, 502);
  }
  return json({ ok: true, module: "asistente", data: { reply } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Método no permitido" }, 405);
  }
  if (!ANTHROPIC_API_KEY) {
    return json(
      { ok: false, error: "ANTHROPIC_API_KEY no configurada en el servidor" },
      500,
    );
  }

  let payload: { module?: string; action?: string; context?: unknown };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ ok: false, error: "JSON inválido en la petición" }, 400);
  }

  const module = clean(payload.module);
  const action = clean(payload.action);
  const context = (payload.context && typeof payload.context === "object")
    ? payload.context as Record<string, unknown>
    : {};

  if (!module) return json({ ok: false, error: "Falta 'module'" }, 400);

  // ── Asistente conversacional ────────────────────────────────────
  if (module === "asistente") {
    try {
      return await handleAsistente(context);
    } catch (e) {
      return json(
        { ok: false, error: "Error en el asistente: " + String((e as Error).message) },
        500,
      );
    }
  }

  // ── Módulos JSON one-shot (leads, onboarding, campaigns, pipeline) ─
  let reqSpec;
  try {
    reqSpec = buildRequest(module, action, context);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 400);
  }

  // Llamada a Claude API (system con prompt caching).
  let aiResp: Response;
  try {
    aiResp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: reqSpec.maxTokens,
        system: [
          {
            type: "text",
            text: reqSpec.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: reqSpec.user }],
      }),
    });
  } catch (e) {
    return json(
      { ok: false, error: "Error de red con Claude API: " + String((e as Error).message) },
      502,
    );
  }

  if (!aiResp.ok) {
    const errTxt = await aiResp.text();
    return json(
      { ok: false, error: "Claude API " + aiResp.status, detail: errTxt },
      502,
    );
  }

  const aiJson = await aiResp.json();
  const text: string = textFromClaude(aiJson);

  let data: unknown;
  if (reqSpec.json) {
    data = extractJSON(text);
    if (data == null) {
      return json(
        { ok: false, error: "La IA no devolvió JSON válido", raw: text },
        502,
      );
    }
  } else {
    data = { system_prompt: text };
  }

  return json({ ok: true, module, action, data, raw: text });
});
