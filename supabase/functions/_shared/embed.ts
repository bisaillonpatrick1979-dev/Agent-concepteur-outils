// Embeddings gratuits, executes directement dans l'Edge Runtime de Supabase.
// Modele : gte-small - 384 dimensions, ~512 tokens max par entree.
// Aucune cle d'API externe requise.

// deno-lint-ignore no-explicit-any
declare const Supabase: any;

// deno-lint-ignore no-explicit-any
let session: any = null;

function getSession() {
  if (!session) session = new Supabase.ai.Session("gte-small");
  return session;
}

export async function embed(text: string): Promise<number[]> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  const out = await getSession().run(clean, {
    mean_pool: true,
    normalize: true,
  });
  return out as number[];
}
