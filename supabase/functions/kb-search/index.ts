// POST /functions/v1/kb-search
// Recherche hybride pure - retourne les extraits, sans passer par le modele.
// Utile pour verifier ce que l'agent voit avant de lui faire confiance.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
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
    const query = String(body?.query ?? "").trim();
    if (!query) return json({ error: "Champ query requis." }, 400);

    const { data, error } = await supabase.rpc("kb_hybrid_search", {
      query_embedding: await embed(query),
      query_text: query,
      match_count: Math.min(Number(body?.k ?? 8), 25),
      p_disciplines: body?.disciplines ?? null,
      p_jurisdictions: body?.jurisdictions ?? null,
      p_source_types: body?.source_types ?? null,
    });

    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, query, resultats: data ?? [] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
