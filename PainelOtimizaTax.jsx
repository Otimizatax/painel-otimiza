import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Instagram, FolderOpen, RefreshCw, FileText, AlertTriangle, ExternalLink } from "lucide-react";

/* -----------------------------------------------------------------
   OTIMIZA TAX — Painel de Gestão de Passivo Tributário  (v4)
   Fonte de dados: planilha "Carteira" publicada no Google Sheets.
   O painel lê a planilha ao vivo; edição acontece no Sheets.
------------------------------------------------------------------ */

// Link "Publicar na web" da aba Carteira (TSV).
const FONTE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS5I71PFzZeg3ht6D2Jp9FHEPGoxqDMvdcNZZ6bNnAinijMxhblU6Xs-kiqqL25fg/pub?gid=1834829609&single=true&output=tsv";
// Link para abrir a planilha e editar (ajuste se quiser apontar para o arquivo editável).
const SHEET_EDIT_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS5I71PFzZeg3ht6D2Jp9FHEPGoxqDMvdcNZZ6bNnAinijMxhblU6Xs-kiqqL25fg/pub";

const ETAPAS = ["Parecer técnico", "Revisão estratégica", "Execução"];
const SITUACOES = ["A classificar", "Em diagnóstico", "Em revisão", "Em execução", "Concluído"];
const COLUNAS_ESPERADAS = ["cliente", "drive_folder_id", "situacao", "passivo_total"];

const HOJE = new Date();

/* ---------- utils ---------- */
// Parser delimitado tolerante a aspas (RFC-4180), funciona p/ TSV e CSV.
function parseDelimitado(texto, delim) {
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else aspas = false;
      } else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === delim) { linha.push(campo); campo = ""; }
    else if (ch === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; }
    else if (ch === "\r") { /* ignora */ }
    else campo += ch;
  }
  if (campo.length || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

// Aceita "1079575.81", "1.079.575,81", "1079575,81" etc.
function numBR(v) {
  if (v == null) return 0;
  let s = String(v).trim().replace(/[R$\s]/g, "");
  if (!s) return 0;
  if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const brl = (v) => (v ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) : "—");
const compacto = (v) => (!v ? "—" : v >= 1e6 ? `R$ ${(v / 1e6).toFixed(2).replace(".", ",")}M` : `R$ ${(v / 1e3).toFixed(0)}k`);
const dataBR = (iso) => {
  if (!iso) return "—";
  const d = new Date(String(iso).trim() + "T12:00:00");
  return isNaN(d) ? String(iso) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "2-digit" });
};
const diasAte = (iso) => {
  const d = new Date(String(iso).trim() + "T12:00:00");
  return isNaN(d) ? null : Math.round((d - HOJE) / 86400000);
};

const CORES = {
  "A classificar": "bg-stone-100 text-stone-500 border border-stone-300",
  "Em diagnóstico": "bg-stone-200 text-stone-700",
  "Em revisão": "bg-amber-100 text-amber-800",
  "Em execução": "bg-emerald-100 text-emerald-800",
  Concluído: "bg-[#3E4247] text-stone-100",
};
const CORES_CAPAG = { A: "text-stone-500", B: "text-red-700", C: "text-amber-700", D: "text-emerald-700" };

const PERIODOS = [
  { rotulo: "30 dias", dias: 30 },
  { rotulo: "90 dias", dias: 90 },
  { rotulo: "Ano", dias: 365 },
  { rotulo: "Tudo", dias: null },
];

function linhasParaClientes(linhas) {
  if (!linhas.length) return { erro: "vazio", clientes: [] };
  const cab = linhas[0].map((h) => h.trim().toLowerCase());
  const faltando = COLUNAS_ESPERADAS.filter((c) => !cab.includes(c));
  if (faltando.length) return { erro: "colunas", faltando, cab, clientes: [] };
  const idx = (nome) => cab.indexOf(nome);
  const clientes = linhas.slice(1)
    .filter((l) => (l[idx("cliente")] || "").trim())
    .map((l) => {
      const g = (nome) => { const i = idx(nome); return i >= 0 ? (l[i] || "").trim() : ""; };
      return {
        cliente: g("cliente"),
        cnpj: g("cnpj"),
        driveId: g("drive_folder_id"),
        entrada: g("data_entrada"),
        capag: g("capag") || "—",
        passivo: numBR(g("passivo_total")),
        pgfn: numBR(g("passivo_pgfn")),
        rfb: numBR(g("passivo_rfb")),
        situacao: g("situacao") || "A classificar",
        etapa: parseInt(g("etapa")) || 0,
        estrategia: g("estrategia"),
        fonte: g("parecer_fonte"),
        honorarioFixo: numBR(g("honorario_fixo")),
        exitoPct: numBR(g("honorario_exito_pct")),
        proximoMarco: g("proximo_marco"),
        pendencias: g("pendencias").split("|").map((s) => s.trim()).filter(Boolean),
      };
    });
  return { erro: null, clientes };
}

export default function PainelOtimizaTax() {
  const [clientes, setClientes] = useState([]);
  const [estado, setEstado] = useState("carregando"); // carregando | ok | erro
  const [erroDetalhe, setErroDetalhe] = useState(null);
  const [atualizadoEm, setAtualizadoEm] = useState(null);
  const [periodo, setPeriodo] = useState(PERIODOS[3]);
  const [situacao, setSituacao] = useState("Todos");
  const [busca, setBusca] = useState("");

  const carregar = useCallback(async () => {
    setEstado("carregando");
    try {
      const resp = await fetch(`${FONTE_URL}&_=${Date.now()}`);
      if (!resp.ok) throw new Error("http " + resp.status);
      const texto = await resp.text();
      const linhas = parseDelimitado(texto, "\t");
      const { erro, faltando, clientes: cs } = linhasParaClientes(linhas);
      if (erro === "colunas") {
        setErroDetalhe(`A aba publicada não tem as colunas esperadas (faltam: ${faltando.join(", ")}). Verifique se você publicou a aba "Carteira".`);
        setEstado("erro");
        return;
      }
      if (erro === "vazio") {
        setErroDetalhe("A planilha voltou vazia.");
        setEstado("erro");
        return;
      }
      setClientes(cs);
      setAtualizadoEm(new Date());
      setEstado("ok");
    } catch (e) {
      setErroDetalhe("Não foi possível ler a planilha publicada. Confira se o link 'Publicar na web' continua ativo.");
      setEstado("erro");
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const noPeriodo = useMemo(
    () => clientes.filter((c) => {
      if (periodo.dias === null) return true;
      const d = diasAte(c.entrada);
      return d === null ? true : -d <= periodo.dias;
    }),
    [clientes, periodo]
  );
  const visiveis = useMemo(
    () => noPeriodo
      .filter((c) => situacao === "Todos" || c.situacao === situacao)
      .filter((c) => c.cliente.toLowerCase().includes(busca.toLowerCase()))
      .sort((a, b) => b.passivo - a.passivo || (b.entrada > a.entrada ? 1 : -1)),
    [noPeriodo, situacao, busca]
  );

  const ativos = noPeriodo.filter((c) => c.situacao !== "Concluído");
  const resumo = {
    fechados: noPeriodo.length,
    ativos: ativos.length,
    passivo: ativos.reduce((s, c) => s + c.passivo, 0),
    honorarios: noPeriodo.reduce((s, c) => s + c.honorarioFixo, 0),
    pendencias: ativos.reduce((s, c) => s + c.pendencias.length, 0),
    aClassificar: noPeriodo.filter((c) => c.situacao === "A classificar").length,
  };

  return (
    <div className="min-h-screen bg-[#F2F0EA] text-[#2E3238]">
      <header className="bg-[#3E4247] text-[#F2F0EA] px-6 py-6 md:px-10">
        <div className="mx-auto max-w-6xl flex items-center justify-between gap-4">
          <div>
            <div className="font-serif text-lg tracking-[0.2em]">OTIMIZA TAX</div>
            <div className="text-[10px] tracking-[0.25em] text-stone-400 mt-0.5">PERFORMANCE TRIBUTÁRIA</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] tracking-[0.2em] text-stone-400">CARTEIRA DE GESTÃO</div>
            <div className="text-sm text-stone-300 mt-0.5">
              {HOJE.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 md:px-10 py-8">
        {/* Barra de origem */}
        <div className="flex flex-wrap items-center gap-3 mb-6 text-xs text-stone-500">
          <span className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Fonte: planilha da carteira no Google Sheets
          </span>
          <button
            onClick={carregar}
            className="flex items-center gap-1.5 px-2.5 py-1 border border-stone-300 hover:border-stone-500 text-stone-600"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${estado === "carregando" ? "animate-spin" : ""}`} /> Atualizar
          </button>
          {atualizadoEm && (
            <span className="text-stone-400">
              Atualizado às {atualizadoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <a href={SHEET_EDIT_URL} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1.5 text-stone-600 hover:text-stone-900">
            <ExternalLink className="w-3.5 h-3.5" /> Abrir planilha
          </a>
        </div>

        {estado === "erro" ? (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 px-5 py-4 text-sm text-stone-700">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-1">Não consegui carregar a carteira.</p>
              <p className="text-stone-600">{erroDetalhe}</p>
              <button onClick={carregar} className="mt-3 px-3 py-1.5 bg-[#3E4247] text-[#F2F0EA] text-xs">Tentar de novo</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-5">
              <span className="text-[11px] tracking-[0.18em] text-stone-500 mr-1">CONTRATOS FECHADOS EM</span>
              {PERIODOS.map((p) => (
                <button
                  key={p.rotulo}
                  onClick={() => setPeriodo(p)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition ${
                    periodo.rotulo === p.rotulo
                      ? "bg-[#3E4247] text-[#F2F0EA] border-[#3E4247]"
                      : "border-stone-300 text-stone-600 hover:border-stone-500"
                  }`}
                >
                  {p.rotulo}
                </button>
              ))}
            </div>

            <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-stone-300 border border-stone-300 mb-6">
              {[
                { n: resumo.fechados, r: "Contratos fechados" },
                { n: resumo.ativos, r: "Contratos ativos" },
                { n: compacto(resumo.passivo), r: "Passivo sob gestão" },
                { n: compacto(resumo.honorarios), r: "Honorários pactuados" },
                { n: resumo.pendencias, r: "Pendências abertas", alerta: resumo.pendencias > 0 },
                { n: resumo.aClassificar, r: "A classificar", alerta: resumo.aClassificar > 0 },
              ].map((k) => (
                <div key={k.r} className="bg-[#F2F0EA] px-4 py-5">
                  <div className={`font-serif text-2xl md:text-[26px] leading-none ${k.alerta ? "text-amber-700" : ""}`}>
                    {estado === "carregando" ? "…" : k.n}
                  </div>
                  <div className="text-[10px] tracking-[0.14em] text-stone-500 mt-2 uppercase">{k.r}</div>
                </div>
              ))}
            </section>

            {resumo.aClassificar > 0 && estado === "ok" && (
              <div className="flex items-start gap-2 text-xs text-stone-600 bg-amber-50 border border-amber-200 px-4 py-3 mb-8">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-px" />
                <span>{resumo.aClassificar} clientes ainda sem parecer/contrato lançados na planilha. Preencha a linha correspondente no Google Sheets e clique em Atualizar.</span>
              </div>
            )}

            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-6">
              <h2 className="font-serif text-2xl mr-auto">Carteira</h2>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar cliente"
                  className="w-full md:w-56 pl-9 pr-3 py-2 text-sm bg-white border border-stone-300 focus:outline-none focus:border-stone-600"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {["Todos", ...SITUACOES].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSituacao(s)}
                    className={`px-2.5 py-1.5 text-xs border transition ${
                      situacao === s
                        ? "bg-[#3E4247] text-[#F2F0EA] border-[#3E4247]"
                        : "bg-white border-stone-300 text-stone-600 hover:border-stone-500"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {estado === "carregando" ? (
              <div className="py-16 text-center text-stone-400 text-sm">Lendo a planilha…</div>
            ) : visiveis.length === 0 ? (
              <div className="border border-dashed border-stone-300 py-16 text-center text-stone-500 text-sm">
                Nenhum cliente neste recorte. Amplie o período ou limpe os filtros.
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-2">
                {visiveis.map((c) => <Card key={c.driveId || c.cliente} c={c} />)}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-stone-300 mt-8 py-6 px-6 md:px-10">
        <div className="mx-auto max-w-6xl flex items-center justify-between text-[10px] tracking-[0.18em] text-stone-400">
          <span className="flex items-center gap-1.5"><Instagram className="w-3.5 h-3.5" /> @OTIMIZATAX</span>
          <span>GESTÃO DE PASSIVO TRIBUTÁRIO</span>
        </div>
      </footer>
    </div>
  );
}

function Card({ c }) {
  const prazo = c.proximoMarco ? diasAte(c.proximoMarco) : null;
  const exito = c.passivo && c.exitoPct ? (c.passivo * 0.5 * c.exitoPct) / 100 : 0;
  return (
    <article className="bg-white border border-stone-200 p-6 flex flex-col hover:border-stone-400 transition">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] tracking-[0.18em] text-stone-400 truncate">
            {c.cnpj || "CNPJ não informado"} · ENTRADA {dataBR(c.entrada)}
          </div>
          <h3 className="font-serif text-xl mt-1 leading-snug">{c.cliente}</h3>
        </div>
        <span className={`shrink-0 text-[10px] tracking-wider px-2.5 py-1 rounded-full ${CORES[c.situacao] || CORES["A classificar"]}`}>
          {c.situacao.toUpperCase()}
        </span>
      </div>

      <div className="flex items-baseline gap-6 mt-4 pb-4 border-b border-stone-100">
        <div>
          <div className="text-[9px] tracking-[0.14em] text-stone-400 uppercase">Passivo global</div>
          <div className="font-serif text-2xl mt-0.5">{brl(c.passivo)}</div>
          {c.passivo > 0 && (
            <div className="text-[11px] text-stone-500 mt-1">PGFN {brl(c.pgfn)} · RFB {brl(c.rfb)}</div>
          )}
        </div>
        <div className="ml-auto text-right">
          <div className="text-[9px] tracking-[0.14em] text-stone-400 uppercase">CAPAG</div>
          <div className={`font-serif text-2xl mt-0.5 ${CORES_CAPAG[c.capag] || "text-stone-400"}`}>{c.capag}</div>
        </div>
      </div>

      <div className="flex gap-1 mt-4">
        {ETAPAS.map((e, i) => (
          <div key={e} className="flex-1">
            <div className={`h-1 ${i < c.etapa ? "bg-[#3E4247]" : "bg-stone-200"}`} />
            <div className={`text-[9px] mt-1.5 tracking-wide uppercase ${i < c.etapa ? "text-stone-600" : "text-stone-400"}`}>{e}</div>
          </div>
        ))}
      </div>

      <p className={`text-sm leading-relaxed mt-5 ${c.estrategia ? "text-stone-600" : "text-stone-400 italic"}`}>
        {c.estrategia || "Parecer ainda não lançado."}
      </p>
      {c.fonte && (
        <div className="flex items-center gap-1.5 text-[10px] text-stone-400 mt-2">
          <FileText className="w-3 h-3" /> {c.fonte}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 mt-5 pt-5 border-t border-stone-200">
        <div>
          <dt className="text-[9px] tracking-[0.14em] text-stone-400 uppercase">Honorário fixo</dt>
          <dd className="text-sm mt-1">{brl(c.honorarioFixo)}</dd>
        </div>
        <div>
          <dt className="text-[9px] tracking-[0.14em] text-stone-400 uppercase">Êxito {c.exitoPct ? `(${c.exitoPct}%)` : ""}</dt>
          <dd className="text-sm mt-1">{exito ? brl(exito) : "a apurar"}</dd>
        </div>
      </dl>

      <div className="mt-5 pt-5 border-t border-stone-200 flex-1">
        <div className="text-[9px] tracking-[0.14em] text-stone-400 uppercase mb-2">Falta executar</div>
        {c.pendencias.length === 0 ? (
          <p className="text-sm text-stone-400 italic">Nenhuma pendência lançada.</p>
        ) : (
          <ul className="space-y-1.5">
            {c.pendencias.map((p, i) => (
              <li key={i} className="text-sm text-stone-700 flex gap-2">
                <span className="text-stone-300 mt-0.5">□</span>
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between mt-5 pt-4 border-t border-stone-100 text-xs">
        {c.driveId ? (
          <a href={`https://drive.google.com/drive/folders/${c.driveId}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-500 hover:text-stone-800">
            <FolderOpen className="w-3.5 h-3.5" /> Pasta no Drive
          </a>
        ) : <span />}
        {prazo !== null && (
          <span className={prazo <= 30 ? "text-amber-700 font-medium" : "text-stone-500"}>
            Próximo marco: {dataBR(c.proximoMarco)}
          </span>
        )}
      </div>
    </article>
  );
}
