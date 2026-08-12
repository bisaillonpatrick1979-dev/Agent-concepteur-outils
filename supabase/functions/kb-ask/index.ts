// POST /functions/v1/kb-ask
// Recherche hybride -> construction du contexte -> reponse de Claude, citee.
//
// Secret requis   : ANTHROPIC_API_KEY
// Secret optionnel: ANTHROPIC_MODEL (defaut : claude-sonnet-4-6)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { embed } from "../_shared/embed.ts";

const SYSTEM = [
  "Tu es l'assistant technique de HailHits Exteriors (Calgary, Alberta), specialise en construction residentielle et commerciale, en enveloppe du batiment et en conception d'outils de chantier.",
  "",
  "REGLES ABSOLUES",
  "1. Tu reponds UNIQUEMENT a partir des EXTRAITS fournis. Si l'information n'y est pas, tu le dis clairement : « Ce n'est pas dans la base de connaissances. » Tu n'inventes jamais un numero d'article, une valeur, une charge ou une dimension.",
  "2. Chaque affirmation technique est suivie de sa source entre crochets : [S1], [S2]...",
  "3. Tu ne calcules jamais une charge, une portee ou une contrainte de tete. Si un calcul est necessaire, tu ecris explicitement quel calcul doit etre fait et avec quels parametres - l'outil de calcul viendra en Phase 2.",
  "4. Quand les sources se contredisent, tu privilegies celle qui fait le plus autorite (code > norme > fabricant > methode interne) et tu signales la contradiction.",
  "5. GARDE-FOU LEGAL : tout element structural, toute charge portante et tout equipement de levage doivent etre scelles par un ingenieur inscrit a l'APEGA en Alberta. Tu es un outil de pre-conception et de verification, jamais la signature finale. Tu le rappelles des qu'une reponse touche le structural.",
  "",
  "STYLE",
  "Francais quebecois, direct, oriente chantier. Pas de remplissage.",
].join("\n");

interface Row {
  chunk_id: string;
  source_title: string;
  publisher: string | null;
  source_type: string;
  authority_level: number;
  source_url: string | null;
  heading: string | null;
  page_ref: string | null;
  content: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const t0 = Date.now();

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Authentification requise." }, 401);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Secret ANTHROPIC_API_KEY absent." }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );

    const body = await req.json();
    const question = String(body?.question ?? "").trim();
    if (!question) return json({ error: "Champ question requis." }, 400);

    const { data, error } = await supabase.rpc("kb_hybrid_search", {
      query_embedding: await embed(question),
      query_text: question,
      match_count: Math.min(Number(body?.k ?? 10), 20),
      p_disciplines: body?.disciplines ?? null,
      p_jurisdictions: body?.jurisdictions ?? null,
      p_source_types: body?.source_types ?? null,
    });
    if (error) return json({ error: error.message }, 400);

    const rows = (data ?? []) as Row[];

    if (rows.length === 0) {
      return json({
        ok: true,
        question,
        reponse:
          "Aucun extrait pertinent dans la base de connaissances. Ajoute la source correspondante avec kb-ingest, puis repose la question.",
        sources: [],
      });
    }

    const contexte = rows
      .map((r, i) => {
        const meta = [r.publisher, r.source_type, r.heading, r.page_ref]
          .filter(Boolean)
          .join(" - ");
        const entete = "[S" + (i + 1) + "] " + r.source_title +
          (meta ? " (" + meta + ")" : "");
        return entete + "\n" + r.content;
      })
      .join("\n\n---\n\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: "EXTRAITS DE LA BASE DE CONNAISSANCES\n\n" + contexte +
            "\n\n---\n\nQUESTION : " + question,
        }],
      }),
    });

    if (!res.ok) {
      return json({ error: "API Anthropic : " + (await res.text()) }, 502);
    }

    const out = await res.json();
    const reponse = (out.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");

    const latence = Date.now() - t0;

    await supabase.from("kb_search_log").insert({
      question,
      filters: {
        disciplines: body?.disciplines ?? null,
        jurisdictions: body?.jurisdictions ?? null,
        source_types: body?.source_types ?? null,
      },
      chunk_ids: rows.map((r) => r.chunk_id),
      answer: reponse,
      model: out.model ?? null,
      latency_ms: latence,
    });

    return json({
      ok: true,
      question,
      reponse,
      latence_ms: latence,
      sources: rows.map((r, i) => ({
        ref: "S" + (i + 1),
        titre: r.source_title,
        editeur: r.publisher,
        type: r.source_type,
        autorite: r.authority_level,
        section: r.heading,
        page: r.page_ref,
        url: r.source_url,
      })),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
