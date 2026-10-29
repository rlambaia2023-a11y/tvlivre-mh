// ============================================================================
// ATUALIZADOR DE GRADE — TV Livre MH
// ============================================================================
// Atualiza a grade de canais (dados/canais.json + dados/lista.m3u) a partir de
// fontes públicas (iptv-org Brasil, Free-TV) e dos canais ao vivo do Saimo TV
// (fontedecanais.me), MESCLANDO sem duplicar e mantendo os que já funcionam.
//
// IMPORTANTE: este script NÃO modifica nenhum código-fonte (server.ts,
// index.html, .bat, .ps1, etc.). Ele apenas reescreve os ARQUIVOS DE DADOS:
//   dados/canais.json  e  dados/lista.m3u
//
// Uso:  node atualizar-grade-saimo.cjs
//       (pode ser agendado no Windows Task Scheduler)
// ============================================================================

import { createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE = 'C:/Users/FBBR/Downloads/tvlivreMH-extracted/tvlivreMH';
const DADOS = join(BASE, 'dados');
const CANAIS_JSON = join(DADOS, 'canais.json');
const LISTA_M3U = join(DADOS, 'lista.m3u');
mkdirSync(DADOS, { recursive: true });

const TIMEOUT = 20000;
// Canais ao vivo identificados no Saimo TV (saimo-tv.pages.dev)
// As URLs abaixo são as streams públicas conhecidas; se o usuário tiver URLs
// próprias no Saimo TV, ele pode editar esta lista.
const CANAIS_SAIMO_TV = [
  { nome: "Band", grupo: "TV aberta", urls: [
    "https://br5093.streamingdevideo.com.br/abc/abc/playlist.m3u8", // exemplo (ajustar conforme o stream real)
  ], logo: "http://www.fontedecanais.me/logos/canais/band.png" },
  { nome: "Band Campinas", grupo: "TV aberta", urls: [], logo: "http://www.fontedecanais.me/logos/canais/band.png" },
  { nome: "Band Curitiba", grupo: "TV aberta", urls: [], logo: "http://www.fontedecanais.me/logos/canais/band.png" },
  { nome: "Saimo TV", grupo: "Geral", urls: [], logo: "" },
];

function chaveDe(nome) {
  return String(nome || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function limparNome(n) {
  return String(n || "")
    .replace(/\s*\(\d+p\)/gi, "").replace(/\s*\[[^\]]*\]/g, "").trim() || n;
}

// Testa se um link de transmissão está no ar (primeiros 64 KB).
async function verificar(url) {
  try {
    const res = await fetch(url, {
      headers: { "range": "bytes=0-65535", "user-agent": "Mozilla/5.0 (TV Livre MH Atualizador)" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok && res.status !== 206) return { ok: false, motivo: "HTTP " + res.status };
    const tipo = res.headers.get("content-type") || "";
    const texto = await res.text();
    if (!texto.trimStart().startsWith("#EXTM3U")) {
      if (/text\/html|json/i.test(tipo)) return { ok: false, motivo: "página, não vídeo" };
      return { ok: true, motivo: "arquivo" };
    }
    return { ok: true, motivo: "no ar" };
  } catch (e) {
    return { ok: false, motivo: String(e).includes("timeout") ? "sem resposta" : "erro de conexão" };
  }
}

// Lê um M3U e devolve [{nome, grupo, logo, url, ref, ua}]
function lerM3U(texto) {
  const out = [];
  let cur = null;
  for (const bruto of texto.split(/\r?\n/)) {
    const l = bruto.trim();
    if (!l) continue;
    if (l.startsWith("#EXTINF")) {
      const at = (k) => (l.match(new RegExp(k + '="([^"]*)"', "i")) || [])[1] || "";
      const nome = l.slice(l.lastIndexOf(",") + 1).trim() || at("tvg-name") || "Sem nome";
      cur = { nome, logo: at("tvg-logo"), grupo: at("group-title"), chave: chaveDe(at("tvg-id")), url: "", ref: at("http-referrer"), ua: at("http-user-agent") };
    } else if (!l.startsWith("#") && cur) {
      cur.url = l;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

async function baixarTexto(u) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

async function main() {
  // 1) Carrega a lista atual (se existir)
  let existentes = [];
  let atualizado = Date.now();
  if (existsSync(CANAIS_JSON)) {
    try {
      const j = JSON.parse(readFileSync(CANAIS_JSON, 'utf8'));
      existentes = Array.isArray(j.canais) ? j.canais : [];
      atualizado = j.atualizado || Date.now();
    } catch {}
  }
  const porChave = new Map();
  for (const c of existentes) porChave.set(c.id, c);
  const porNome = new Map();
  for (const c of existentes) porNome.set(chaveDe(c.name), c);

  // 2) Busca fontes públicas
  const fontes = [];
  const brM3U = await baixarTexto("https://iptv-org.github.io/iptv/countries/br.m3u");
  if (brM3U.includes("#EXTM3U")) fontes.push(...lerM3U(brM3U).map(f => ({ ...f, grupo: f.grupo || "TV aberta" })));
  const freeTv = await baixarTexto("https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_brazil.m3u8");
  if (freeTv.includes("#EXTM3U")) fontes.push(...lerM3U(freeTv).map(f => ({ ...f, grupo: f.grupo || "TV aberta" })));

  // 3) Canais do Saimo TV (somente os que tiverem URL válida)
  for (const c of CANAIS_SAIMO_TV) {
    for (const u of c.urls) {
      fontes.push({ nome: c.nome, grupo: c.grupo, logo: c.logo, chave: chaveDe(c.nome), url: u, ref: "", ua: "" });
    }
  }

  // 4) Testa links únicos e constrói novos canais
  const unicos = [];
  const viuUrl = new Set();
  for (const f of fontes) {
    if (!f.url || viuUrl.has(f.url)) continue;
    viuUrl.add(f.url);
    unicos.push(f);
  }

  console.log(`Links únicos para testar: ${unicos.length}`);
  const bons = [];
  const LOTE = 12;
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    const resultados = await Promise.all(lote.map(async (f) => ({ f, r: await verificar(f.url) })));
    for (const { f, r } of resultados) {
      if (r.ok) bons.push(f);
      else console.log("  ↓", f.nome || f.url.slice(0,40), "->", r.motivo);
    }
    // pequeno atraso entre lotes para não saturar a rede
    await new Promise((ok) => setTimeout(ok, 400));
  }
  console.log(`Links funcionando: ${bons.length} / ${unicos.length}`);

  // 5) Agrupa por chave (mesmo canal = mesmo ID) e adiciona os novos
  let adicionados = 0;
  const gruposFonte = new Map();
  for (const f of bons) {
    const g = gruposFonte.get(f.chave) || [];
    if (!g.some((x) => x.url === f.url)) g.push(f);
    gruposFonte.set(f.chave, g);
  }

  const novosCanais = [];
  const agora = Date.now();
  for (const [chave, lista] of gruposFonte) {
    const p = lista[0];
    const eraConhecido = porChave.has(chave) || porNome.has(chaveDe(p.nome));
    if (eraConhecido) continue; // já existe: não duplica
    novosCanais.push({
      id: chave,
      name: limparNome(p.nome),
      logo: (lista.find((f) => f.logo) || p).logo || "",
      group: p.grupo || "Geral",
      url: p.url,
      ref: p.ref || "",
      ua: p.ua || "",
      alts: lista.slice(1).map((f) => ({ url: f.url, ref: f.ref || "", ua: f.ua || "" })),
      novoEm: agora,
    });
    adicionados++;
  }

  // 6) Mescla: mantém os antigos (incluindo Pluto que o servidor renova) e adiciona os novos
  const finais = [...existentes, ...novosCanais];
  // Remove possíveis duplicatas exatas de URL entre os antigos
  const vistoUrl = new Set();
  const dedup = [];
  for (const c of finais) {
    if (c.url && vistoUrl.has(c.url)) continue;
    if (c.url) vistoUrl.add(c.url);
    dedup.push(c);
  }

  const saida = { atualizado: agora, canais: dedup };
  writeFileSync(CANAIS_JSON, JSON.stringify(saida, null, 2));

  // 7) Gera lista.m3u
  const linhas = ["#EXTM3U"];
  dedup.forEach((c, i) => {
    const q = (t) => t.replace(/"/g, "'");
    linhas.push('#EXTINF:-1 tvg-chno="' + (i + 1) + '" tvg-id="' + q(c.id) + '" tvg-logo="' + q(c.logo) + '" group-title="' + q(c.group) + '",' + c.name);
    if (c.ref) linhas.push("#EXTVLCOPT:http-referrer=" + c.ref);
    if (c.ua) linhas.push("#EXTVLCOPT:http-user-agent=" + c.ua);
    linhas.push(c.url);
  });
  writeFileSync(LISTA_M3U, linhas.join("\n") + "\n");

  console.log("=== RESULTADO ===");
  console.log("Canais antes:", existentes.length);
  console.log("Novos adicionados:", adicionados);
  console.log("Total depois:", dedup.length);
  console.log("Gravado:", CANAIS_JSON);
  console.log("Gravado:", LISTA_M3U);
}

main().catch((e) => { console.error("ERRO:", e); process.exit(1); });
