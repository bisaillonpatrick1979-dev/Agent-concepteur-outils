// POST /functions/v1/kb-ingest
// Ajoute un document a la base de connaissances : decoupage + vectorisation.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { chunkText } from "../_shared/chunk.ts";
import { embed } from "../_shared/embed.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Authentification requise." }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );

    const body = await req.json();
    const { title, source_type, text } = body ?? {};

    if (!title || !source_type || !text || String(text).trim().length < 20) {
      return json(
        { error: "Champs requis : title, source_type, text (min. 20 caracteres)." },
        400,
      );
    }

    const { data: source, error: srcErr } = await supabase
      .from("kb_sources")
      .insert({
        title,
        source_type,
        publisher: body.publisher ?? null,
        jurisdiction: body.jurisdiction ?? null,
        discipline: body.discipline ?? [],
        version: body.version ?? null,
        effective_date: body.effective_date ?? null,
        source_url: body.source_url ?? null,
        authority_level: body.authority_level ?? 4,
        raw_text: text,
        metadata: body.metadata ?? {},
      })
      .select("id")
      .single();

    if (srcErr) return json({ error: srcErr.message }, 400);

    const chunks = chunkText(String(text));
    if (chunks.length === 0) {
      return json({ error: "Aucun contenu exploitable apres decoupage." }, 400);
    }

    const rows = [];
    for (const c of chunks) {
      rows.push({
        source_id: source.id,
        chunk_index: c.index,
        heading: c.heading,
        page_ref: body.page_ref ?? null,
        content: c.content,
        token_count: c.tokenCount,
        embedding: await embed(c.content),
      });
    }

    // Insertion par lots pour eviter les charges utiles trop grosses.
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await supabase
        .from("kb_chunks")
        .insert(rows.slice(i, i + 50));
      if (error) return json({ error: error.message, source_id: source.id }, 400);
    }

    return json({
      ok: true,
      source_id: source.id,
      titre: title,
      chunks: rows.length,
      tokens_estimes: rows.reduce((a, r) => a + (r.token_count ?? 0), 0),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
