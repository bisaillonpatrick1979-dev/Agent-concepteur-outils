// Decoupage intelligent : respecte les titres d'articles et les paragraphes.
// Cible ~900 caracteres par chunk (~220 tokens) avec chevauchement,
// pour rester bien en dessous de la limite de gte-small.

export interface Chunk {
  index: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}

const TARGET = 900;
const OVERLAP = 150;

// Reconnait : "9.23.13 Titre", "4.2", "## Titre", "ARTICLE 5"
const HEADING_RE =
  /^(?:#{1,6}\s+.+|\d+(?:\.\d+){1,4}\s+\S.*|ARTICLE\s+\d+.*|SECTION\s+\d+.*)$/i;

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

interface Block {
  heading: string | null;
  text: string;
}

function splitByHeadings(raw: string): Block[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let heading: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) blocks.push({ heading, text });
    buf = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (t && t.length < 120 && HEADING_RE.test(t)) {
      flush();
      heading = t.replace(/^#{1,6}\s+/, "");
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks.length ? blocks : [{ heading: null, text: raw.trim() }];
}

function splitLong(text: string): string[] {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  const out: string[] = [];
  let cur = "";

  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };

  for (const p of paras) {
    if (p.length > TARGET) {
      push();
      const sentences = p.match(/[^.!?]+[.!?]+|\S+$/g) ?? [p];
      let s = "";
      for (const sent of sentences) {
        if ((s + sent).length > TARGET && s) {
          out.push(s.trim());
          s = s.slice(-OVERLAP) + sent;
        } else {
          s += sent;
        }
      }
      if (s.trim()) out.push(s.trim());
    } else if ((cur + "\n\n" + p).length > TARGET && cur) {
      push();
      cur = p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  push();
  return out;
}

export function chunkText(raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;

  for (const block of splitByHeadings(raw)) {
    for (const piece of splitLong(block.text)) {
      // Le titre est repete dans le contenu : il aide autant le vecteur
      // que la recherche plein texte a retrouver le bon article.
      const content = block.heading ? block.heading + "\n" + piece : piece;
      chunks.push({
        index: i++,
        heading: block.heading,
        content,
        tokenCount: approxTokens(content),
      });
    }
  }
  return chunks;
}
