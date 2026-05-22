// ════════════════════════════════════════════════════════════════
// rag-ingest · Edge Function (Supabase / Deno)
// Indexa documentos en el RAG de un cliente de WhiteMoon.
//
// Acepta tres formas de entrada:
//   1. JSON:        { cliente_id, nombre_archivo, texto }
//   2. multipart:   form-data con campos `cliente_id` y `file`
//   3. PDF binario: body application/pdf (o octet-stream) con los
//                   metadatos en query (?cliente_id=&nombre_archivo=)
//
// Los PDF se extraen SERVER-SIDE con unpdf (build serverless de
// Mozilla pdf.js) para obtener texto limpio, sin ruido de binarios.
// El texto se trocea en chunks, se vectoriza (Voyage / OpenAI) y se
// guarda en rag_documentos; el archivo se registra en rag_archivos.
// ════════════════════════════════════════════════════════════════
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@1.6.2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cliente-id, x-nombre-archivo",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

// ── Extracción de texto ──────────────────────────────────────────

// Extrae texto limpio de un PDF binario con pdf.js (vía unpdf).
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : (text || "");
}

const isPdf = (name: string, type: string) =>
  /\.pdf$/i.test(name) || type.toLowerCase() === "application/pdf";

// Devuelve el texto de un File: PDF → pdf.js; el resto → texto plano.
async function extractFileText(file: File): Promise<string> {
  if (isPdf(file.name || "", file.type || "")) {
    return await extractPdfText(new Uint8Array(await file.arrayBuffer()));
  }
  return await file.text();
}

// Normaliza el texto: descarta caracteres de control (excepto tab,
// salto de línea y retorno) y colapsa espacios y saltos sobrantes.
function cleanText(t: string): string {
  const src = t || "";
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c >= 32) out += src[i];
  }
  return out
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tipoArchivo(nombre: string): string {
  const m = (nombre || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "txt";
}

// ── Chunking ─────────────────────────────────────────────────────
// Trocea el texto en chunks de ~2000 chars con solapamiento.
function chunkText(text: string, chunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }
  return chunks.filter((c) => c.length > 50);
}

// ── Embeddings: Voyage AI (mejor para español) o fallback OpenAI ──
async function generateEmbedding(text: string): Promise<number[]> {
  const voyageKey = Deno.env.get("VOYAGE_API_KEY") ?? "";
  if (voyageKey) {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${voyageKey}`,
      },
      body: JSON.stringify({ model: "voyage-3-lite", input: [text] }),
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.data[0].embedding;
    }
  }

  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (openaiKey) {
    const r2 = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    if (r2.ok) {
      const d2 = await r2.json();
      return d2.data[0].embedding;
    }
  }

  throw new Error("No hay proveedor de embeddings configurado. Configura VOYAGE_API_KEY u OPENAI_API_KEY.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const url = new URL(req.url);
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    let clienteId = "";
    let nombreArchivo = "";
    let texto = "";
    let tamanoBytes: number | null = null;

    if (contentType.includes("multipart/form-data")) {
      // Subida de archivo (PDF, TXT, …)
      const formData = await req.formData();
      clienteId = (formData.get("cliente_id") as string) || "";
      const file = formData.get("file") as File | null;
      if (!clienteId || !file) return json({ error: "Faltan cliente_id o file" }, 400);
      nombreArchivo = file.name || "documento";
      tamanoBytes = file.size ?? null;
      texto = await extractFileText(file);
    } else if (contentType.includes("application/pdf") || contentType.includes("application/octet-stream")) {
      // PDF binario directo; metadatos en query o cabeceras
      clienteId = url.searchParams.get("cliente_id") || req.headers.get("x-cliente-id") || "";
      nombreArchivo = url.searchParams.get("nombre_archivo") || req.headers.get("x-nombre-archivo") || "documento.pdf";
      if (!clienteId) return json({ error: "Falta cliente_id" }, 400);
      const bytes = new Uint8Array(await req.arrayBuffer());
      tamanoBytes = bytes.byteLength;
      texto = await extractPdfText(bytes);
    } else {
      // JSON con texto directo (back-compat)
      const body = await req.json();
      clienteId = body.cliente_id;
      nombreArchivo = body.nombre_archivo || "documento.txt";
      texto = body.texto;
      if (!clienteId || !texto) return json({ error: "Faltan cliente_id o texto" }, 400);
    }

    texto = cleanText(texto);
    if (texto.length < 20) {
      return json({ error: "No se pudo extraer texto legible del documento" }, 422);
    }

    const supabase = createClient(SB_URL, SB_SERVICE_KEY);

    // Registrar el archivo
    const { data: archivo, error: archivoError } = await supabase
      .from("rag_archivos")
      .insert({
        cliente_id: clienteId,
        nombre_archivo: nombreArchivo,
        tipo_archivo: tipoArchivo(nombreArchivo),
        tamano_bytes: tamanoBytes,
        estado: "procesando",
      })
      .select()
      .single();

    if (archivoError) return json({ error: archivoError.message }, 500);

    // Trocear el texto
    const chunks = chunkText(texto);
    const resultados: Array<{ chunk: number; ok: boolean; error?: string }> = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await generateEmbedding(chunks[i]);
        const { error: insertError } = await supabase.from("rag_documentos").insert({
          cliente_id: clienteId,
          nombre_archivo: nombreArchivo,
          chunk_index: i,
          contenido_chunk: chunks[i],
          embedding: JSON.stringify(embedding),
          tokens_estimados: Math.ceil(chunks[i].length / 4),
        });
        if (!insertError) resultados.push({ chunk: i, ok: true });
        else resultados.push({ chunk: i, ok: false, error: insertError.message });
      } catch (e) {
        resultados.push({ chunk: i, ok: false, error: String((e as Error).message) });
      }
    }

    // Actualizar estado del archivo
    const chunksOk = resultados.filter((r) => r.ok).length;
    await supabase.from("rag_archivos").update({
      estado: chunksOk > 0 ? "listo" : "error",
      chunks_generados: chunksOk,
      error_mensaje: chunksOk === 0 ? "No se pudo procesar ningún chunk" : null,
    }).eq("id", archivo.id);

    return json({
      ok: true,
      archivo_id: archivo.id,
      chunks: chunksOk,
      chunks_procesados: chunksOk,
      chunks_generados: chunksOk,
      total_chunks: chunks.length,
      caracteres_extraidos: texto.length,
      resultados,
    });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
