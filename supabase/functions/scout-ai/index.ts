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
"Laura" es el agente conversacional de IA que WhiteMoon despliega para sus clientes.
Escribe SIEMPRE en español de España, tono profesional pero cercano, tratando de "tú". Sé concreto y comercial, evita relleno y promesas que no se puedan cumplir. Plazos de entrega: "5-7 días laborables".`;

const clean = (v: unknown) => (v == null ? "" : String(v)).trim();

// ── Construcción del prompt por módulo/acción ────────────────────
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

    // ── ONBOARDING: generar system prompt de Laura IA ──────────────
    case "onboarding": {
      const system =
        `${BRAND}\n\nEres un experto en diseño de agentes conversacionales. Generas el SYSTEM PROMPT completo y listo para producción del agente "Laura" de un cliente concreto de WhiteMoon.\n` +
        `El system prompt debe estar escrito en español, en segunda persona dirigida al agente ("Eres Laura..."), e incluir: identidad y rol, tono de voz, objetivos (captar/cualificar/agendar), qué datos recoge, qué NO debe hacer (no inventar precios ni diagnósticos, derivar a humano cuando proceda), y estilo de respuesta (breve, una pregunta a la vez).\n` +
        `Devuelve ÚNICAMENTE el texto del system prompt, sin comentarios, sin markdown, sin comillas envolventes.`;
      const user =
        `Genera el system prompt de Laura para este cliente:\n` +
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
  const text: string = Array.isArray(aiJson?.content)
    ? aiJson.content.filter((b: { type?: string }) => b.type === "text")
        .map((b: { text?: string }) => b.text || "")
        .join("\n")
        .trim()
    : "";

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
