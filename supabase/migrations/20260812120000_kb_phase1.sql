-- =====================================================================
-- Agent concepteur d'outils - Phase 1 : base de connaissances (RAG)
-- Embeddings : gte-small (384 dimensions), gratuit, integre aux Edge Functions
-- Recherche  : hybride (vectorielle + plein texte FR/EN) fusionnee par RRF
-- =====================================================================

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Sources : un document = une source
-- ---------------------------------------------------------------------
create table if not exists public.kb_sources (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,

  title           text not null,
  source_type     text not null check (source_type in (
                    'code',
                    'norme',
                    'fiche_technique',
                    'methode_interne',
                    'prix',
                    'soumission',
                    'manuel',
                    'note'
                  )),
  publisher       text,
  jurisdiction    text,
  discipline      text[] not null default '{}',
  version         text,
  effective_date  date,
  source_url      text,

  -- 1 = code / loi (fait autorite)  ->  5 = note personnelle
  authority_level int not null default 4 check (authority_level between 1 and 5),

  raw_text        text,
  metadata        jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists kb_sources_owner_idx      on public.kb_sources (owner_id);
create index if not exists kb_sources_type_idx       on public.kb_sources (source_type);
create index if not exists kb_sources_discipline_idx on public.kb_sources using gin (discipline);
create index if not exists kb_sources_title_trgm_idx on public.kb_sources using gin (title extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 2. Chunks : morceaux vectorises d'une source
-- ---------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source_id    uuid not null references public.kb_sources(id) on delete cascade,

  chunk_index  int  not null,
  heading      text,
  page_ref     text,
  content      text not null,
  token_count  int,

  embedding    extensions.vector(384),

  fts tsvector generated always as (
    to_tsvector('french',  coalesce(heading,'') || ' ' || content) ||
    to_tsvector('english', coalesce(heading,'') || ' ' || content)
  ) stored,

  created_at   timestamptz not null default now(),
  unique (source_id, chunk_index)
);

create index if not exists kb_chunks_source_idx on public.kb_chunks (source_id);
create index if not exists kb_chunks_owner_idx  on public.kb_chunks (owner_id);
create index if not exists kb_chunks_fts_idx    on public.kb_chunks using gin (fts);
create index if not exists kb_chunks_vec_idx    on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------
-- 3. Journal des recherches - tracabilite de chaque reponse
-- ---------------------------------------------------------------------
create table if not exists public.kb_search_log (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question      text not null,
  filters       jsonb not null default '{}'::jsonb,
  chunk_ids     uuid[] not null default '{}',
  answer        text,
  model         text,
  latency_ms    int,
  created_at    timestamptz not null default now()
);

create index if not exists kb_search_log_owner_idx on public.kb_search_log (owner_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.kb_sources    enable row level security;
alter table public.kb_chunks     enable row level security;
alter table public.kb_search_log enable row level security;

drop policy if exists kb_sources_owner_all on public.kb_sources;
create policy kb_sources_owner_all on public.kb_sources
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists kb_chunks_owner_all on public.kb_chunks;
create policy kb_chunks_owner_all on public.kb_chunks
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists kb_search_log_owner_all on public.kb_search_log;
create policy kb_search_log_owner_all on public.kb_search_log
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- 5. Recherche hybride (RRF : Reciprocal Rank Fusion)
--    Combine le sens (vecteurs) et les mots exacts (plein texte).
--    Les numeros d'article se retrouvent par le lexical,
--    les questions floues par le vectoriel.
-- ---------------------------------------------------------------------
create or replace function public.kb_hybrid_search(
  query_embedding  extensions.vector(384),
  query_text       text default null,
  match_count      int  default 8,
  p_disciplines    text[] default null,
  p_jurisdictions  text[] default null,
  p_source_types   text[] default null,
  rrf_k            int  default 50
)
returns table (
  chunk_id        uuid,
  source_id       uuid,
  source_title    text,
  publisher       text,
  source_type     text,
  authority_level int,
  source_url      text,
  heading         text,
  page_ref        text,
  content         text,
  similarity      double precision,
  score           double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with candidates as (
    select c.id, c.source_id, c.heading, c.page_ref, c.content, c.embedding, c.fts
    from public.kb_chunks c
    join public.kb_sources s on s.id = c.source_id
    where (p_disciplines   is null or s.discipline && p_disciplines)
      and (p_jurisdictions is null or s.jurisdiction = any(p_jurisdictions))
      and (p_source_types  is null or s.source_type  = any(p_source_types))
  ),
  q as (
    select case
             when query_text is null or btrim(query_text) = '' then null
             else websearch_to_tsquery('french', query_text)
                  || websearch_to_tsquery('english', query_text)
           end as tsq
  ),
  sem as (
    select id,
           row_number() over (order by embedding <=> query_embedding) as rnk,
           1 - (embedding <=> query_embedding) as sim
    from candidates
    where embedding is not null
    order by embedding <=> query_embedding
    limit greatest(match_count * 5, 40)
  ),
  lex as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk
    from candidates c, q
    where q.tsq is not null and c.fts @@ q.tsq
    order by ts_rank_cd(c.fts, q.tsq) desc
    limit greatest(match_count * 5, 40)
  ),
  fused as (
    select coalesce(sem.id, lex.id) as id,
           sem.sim,
           coalesce(1.0 / (rrf_k + sem.rnk), 0.0)
         + coalesce(1.0 / (rrf_k + lex.rnk), 0.0) as base_score
    from sem full outer join lex on sem.id = lex.id
  )
  select ch.id,
         s.id,
         s.title,
         s.publisher,
         s.source_type,
         s.authority_level,
         s.source_url,
         ch.heading,
         ch.page_ref,
         ch.content,
         coalesce(f.sim, 0.0)::double precision,
         -- petit bonus aux sources qui font autorite (code > note perso)
         (f.base_score + (6 - s.authority_level) * 0.0004)::double precision
  from fused f
  join public.kb_chunks  ch on ch.id = f.id
  join public.kb_sources s  on s.id = ch.source_id
  order by 12 desc
  limit match_count;
$$;

-- ---------------------------------------------------------------------
-- 6. Vue de suivi
-- ---------------------------------------------------------------------
create or replace view public.kb_stats
with (security_invoker = true) as
select s.source_type,
       count(distinct s.id)  as nb_sources,
       count(c.id)           as nb_chunks,
       count(c.id) filter (where c.embedding is null) as chunks_sans_embedding,
       max(s.updated_at)     as derniere_maj
from public.kb_sources s
left join public.kb_chunks c on c.source_id = s.id
group by s.source_type;

-- ---------------------------------------------------------------------
-- 7. updated_at automatique
-- ---------------------------------------------------------------------
create or replace function public.kb_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists kb_sources_touch on public.kb_sources;
create trigger kb_sources_touch before update on public.kb_sources
  for each row execute function public.kb_touch_updated_at();
