// ============================================================================
// ATUALIZADOR DE GRADE — TV Livre MH (seguro, não modifica códigos-fonte)
// ============================================================================
// Este script SOMENTE reescreve os ARQUIVOS DE DADOS:
//   dados/canais.json   e   dados/lista.m3u
// NÃO toca em server.ts, index.html, .bat, .ps1, etc.
//
// Como usar:
//   node atualizar-grade.mjs                      -> mantém a grade atual e regenera os arquivos
//   node atualizar-grade.mjs --lista https://...  -> mescla também um M3U/JSON externo
//                                                      (pode apontar para sua lista do Saimo TV,
//                                                       fontedecanais.me, iptv-org, etc.)
//
// O tvlivreMH já renova sozinho a cada 6h. Este script serve para adicionar
// canais de uma fonte externa (ex.: sua grade do Saimo TV) sem duplicar.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE = 'C:/Users/FBBR/Downloads/tvlivreMH-extracted/tvlivreMH';
const DADOS = join(BASE, 'dados');
const CANAIS_JSON = join(DADOS, 'canais.json');
const LISTA_M3U = join(DADOS, 'lista.m3u');
mkdirSync(DADOS, { recursive: true });

const args = process.argv.slice(2);
const LISTA_URL = args.find((a) => a.startsWith("--lista="))?.slice("--lista=".length);

function chaveDe(nome) {
  return String(nome || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function limparNome(n) {
  return String(n || "")
    .replace(/\s*\(\d+p\)/gi, "").replace(/\s*\[[^\]]*\]/g, "").trim() || n;
}
function grupoPt(g) {
  const k = (g || "").split(";")[0].trim().toLowerCase();
  const MAP = {
    news: "Notícias", entertainment: "Entretenimento", kids: "Infantil", animation: "Infantil",
    sports: "Esportes", religious: "Religioso", music: "Música", movies: "Filmes", series: "Séries",
    education: "Educação", general: "Geral", shop: "Compras", documentary: "Documentários",
    business: "Negócios", culture: "Cultura", lifestyle: "Estilo de vida", legislative: "Governo",
    outdoor: "Campo e natureza", comedy: "Comédia", cooking: "Culinária", travel: "Viagem",
    auto: "Automóveis", classic: "Clássicos", family: "Família", science: "Ciência", weather: "Clima",
    brazil: "TV aberta", brasil: "TV aberta", doramas: "Doramas", coreia: "Coreia",
  };
  return MAP[k] || k || "Geral";
}

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
    const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

async function main() {
  // 1) Carrega a lista atual (nunca remove nada do que já funciona)
  let existentes = [];
  let atualizado = Date.now();
  if (existsSync(CANAIS_JSON)) {
    try {
      const j = JSON.parse(readFileSync(CANAIS_JSON, 'utf8'));
      existentes = Array.isArray(j.canais) ? j.canais : [];
      atualizado = j.atualizado || Date.now();
    } catch {}
  }
  const porChave = new Map(existentes.map((c) => [c.id, c]));
  const porNome = new Map(existentes.map((c) => [chaveDe(c.name), c]));

  // 2) Carrega lista externa (se informada) — ex.: sua grade do Saimo TV
  let externas = [];
  if (LISTA_URL) {
    const texto = await baixarTexto(LISTA_URL);
    if (texto.includes("#EXTM3U")) {
      externas = lerM3U(texto).map((f) => ({ ...f, grupo: f.grupo || "Geral" }));
    } else {
      try {
        const j = JSON.parse(texto);
        externas = (Array.isArray(j) ? j : j.canais || []).map((c) => ({
          nome: c.name, grupo: c.group || "Geral", logo: c.logo || "",
          chave: c.id || chaveDe(c.name), url: c.url, ref: c.ref || "", ua: c.ua || "",
        }));
      } catch { externas = []; }
    }
    console.log(`Canais da lista externa (${LISTA_URL}): ${externas.length}`);
  }

  // 3) Agrupa externas por chave e adiciona somente as NOVAS (não duplicam)
  const gruposFonte = new Map();
  for (const f of externas) {
    if (!f.url) continue;
    const g = gruposFonte.get(f.chave) || [];
    if (!g.some((x) => x.url === f.url)) g.push(f);
    gruposFonte.set(f.chave, g);
  }

  let adicionados = 0;
  const agora = Date.now();
  const novos = [];
  for (const [chave, lista] of gruposFonte) {
    const jaExiste = porChave.has(chave) || porNome.has(chaveDe(lista[0].nome));
    if (jaExiste) continue;
    const p = lista[0];
    novos.push({
      id: chave,
      name: limparNome(p.nome),
      logo: (lista.find((f) => f.logo) || p).logo || "",
      group: grupoPt(p.grupo),
      url: p.url,
      ref: p.ref || "",
      ua: p.ua || "",
      alts: lista.slice(1).map((f) => ({ url: f.url, ref: f.ref || "", ua: f.ua || "" })),
      novoEm: agora,
    });
    adicionados++;
  }

  // 4) Dedup apenas entre os NOVOS: não adiciona um novo se a URL já existe entre os antigos
  const vistoUrlAntigo = new Set(existentes.filter((c) => c.url).map((c) => c.url));
  const dedupNovos = [];
  for (const c of novos) {
    if (c.url && vistoUrlAntigo.has(c.url)) continue;
    if (c.url) vistoUrlAntigo.add(c.url);
    dedupNovos.push(c);
  }

  // 5) Mescla: mantém TODOS os existentes intactos + novos dedupados
  const finais = [...existentes, ...dedupNovos];

  const saida = { atualizado: agora, canais: finais };
  writeFileSync(CANAIS_JSON, JSON.stringify(saida, null, 2));

  const linhas = ["#EXTM3U"];
  finais.forEach((c, i) => {
    const q = (t) => t.replace(/"/g, "'");
    linhas.push('#EXTINF:-1 tvg-chno="' + (i + 1) + '" tvg-id="' + q(c.id) + '" tvg-logo="' + q(c.logo) + '" group-title="' + q(c.group) + '",' + c.name);
    if (c.ref) linhas.push("#EXTVLCOPT:http-referrer=" + c.ref);
    if (c.ua) linhas.push("#EXTVLCOPT:http-user-agent=" + c.ua);
    linhas.push(c.url);
  });
  writeFileSync(LISTA_M3U, linhas.join("\n") + "\n");

  console.log("=== ATUALIZAÇÃO DE GRADE (sem tocar em códigos-fonte) ===");
  console.log("Canais antes:", existentes.length);
  console.log("Novos adicionados:", adicionados, (LISTA_URL ? "da lista " + LISTA_URL : ""));
  console.log("Total depois:", finais.length);
  console.log("Gravado:", CANAIS_JSON);
  console.log("Gravado:", LISTA_M3U);
}

main().catch((e) => { console.error("ERRO:", e); process.exit(1); });
