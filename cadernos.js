// Cadernos de atividades Conosco: a secretaria define quando cada bimestre é liberado ("liberar em") e a família
// vê, no portal, só os cadernos já liberados da série do filho (PDF para imprimir e versão interativa).
// Os arquivos ficam na pasta cadernos/arquivos (catálogo em cadernos/catalogo.json).
const fs = require('fs');
const path = require('path');

const PADRAO_BIM = (ano) => ({ 1: `${ano}-01-11`, 2: `${ano}-03-29`, 3: `${ano}-07-26`, 4: `${ano}-10-04` }); // 1 semana antes de cada bimestre (aulas 18/01, 05/04, 02/08, 11/10)
const DATA_OK = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00'));
const hojeLocal = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // horário de Brasília

function registrar({ db, rota, A, ErroHttp, CABECALHOS, ANO_LETIVO, filhoDoPai }) {
  const P = { pais: true };
  const PASTA = path.join(__dirname, 'cadernos');
  db.exec(`CREATE TABLE IF NOT EXISTS cadernos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serie TEXT NOT NULL,
    numero INTEGER NOT NULL,
    titulo TEXT NOT NULL,
    bimestre INTEGER NOT NULL,
    arquivo TEXT NOT NULL,
    liberar_em TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    UNIQUE (serie, numero)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cad_acesso (
    aluno_id INTEGER NOT NULL,
    ano INTEGER NOT NULL,
    plano TEXT NOT NULL,
    em TEXT NOT NULL,
    PRIMARY KEY (aluno_id, ano)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS pais_aparelhos (responsavel_id INTEGER NOT NULL, did TEXT NOT NULL, criado_em TEXT NOT NULL, PRIMARY KEY (responsavel_id, did))');
  db.exec('CREATE TABLE IF NOT EXISTS cad_downloads (id INTEGER PRIMARY KEY, responsavel_id INTEGER NOT NULL, aluno_id INTEGER NOT NULL, caderno_id INTEGER NOT NULL, dia TEXT NOT NULL, em TEXT NOT NULL)');
  const LIMITE_PDF_DIA = 40;
  const PLANOS = { plataforma: 'Plataforma', apostilas: 'Plataforma + apostilas' };
  const planoDoAluno = (alunoId) => (db.prepare('SELECT plano FROM cad_acesso WHERE aluno_id = ? AND ano = ?').get(Number(alunoId), Number(ANO_LETIVO)) || {}).plano || null;
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(PASTA, 'catalogo.json'), 'utf8'));
    const ins = db.prepare('INSERT OR IGNORE INTO cadernos (serie, numero, titulo, bimestre, arquivo) VALUES (?,?,?,?,?)');
    for (const c of cat) ins.run(c.serie, c.numero, c.titulo, c.bimestre, c.arquivo);
  } catch (e) { console.error('Cadernos: catálogo não encontrado (pasta cadernos).', e.message); }
  const cfgGet = (k) => (db.prepare('SELECT valor FROM config WHERE chave = ?').get(k) || {}).valor;
  const datasBim = () => { const d = PADRAO_BIM(ANO_LETIVO); const o = {}; for (const n of [1, 2, 3, 4]) { const v = cfgGet('cad_bim' + n); o[n] = v && DATA_OK(v) ? v : d[n]; } return o; };
  const efetiva = (c, bim) => c.liberar_em || bim[c.bimestre];

  // ---------- secretaria ----------
  rota('GET', /^\/api\/admin\/cadernos$/, async () => {
    const bim = datasBim();
    return {
      ano: ANO_LETIVO, bimestres: bim,
      cadernos: db.prepare('SELECT * FROM cadernos ORDER BY serie, numero').all().map((c) => ({ ...c, efetiva: efetiva(c, bim) })),
    };
  }, A);
  rota('PUT', /^\/api\/admin\/cadernos\/bimestres$/, async ({ body }) => {
    for (const n of [1, 2, 3, 4]) {
      const v = String((body.datas || {})[n] || '');
      if (!DATA_OK(v)) throw new ErroHttp(400, `Data do ${n}º bimestre inválida.`);
      db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run('cad_bim' + n, v);
    }
    return { ok: true, bimestres: datasBim() };
  }, A);
  rota('PUT', /^\/api\/admin\/cadernos\/(\d+)$/, async ({ params, body }) => {
    const c = db.prepare('SELECT * FROM cadernos WHERE id = ?').get(Number(params[0]));
    if (!c) throw new ErroHttp(404, 'Caderno não encontrado.');
    const lib = body.liberar_em === '' || body.liberar_em == null ? null : String(body.liberar_em);
    if (lib && !DATA_OK(lib)) throw new ErroHttp(400, 'Data inválida.');
    const bimestre = [1, 2, 3, 4].includes(Number(body.bimestre)) ? Number(body.bimestre) : c.bimestre;
    db.prepare('UPDATE cadernos SET liberar_em = ?, bimestre = ?, ativo = ? WHERE id = ?').run(lib, bimestre, body.ativo === false || body.ativo === 0 ? 0 : 1, c.id);
    return { ok: true };
  }, A);

  // ---------- quem pagou o plano Conosco Digital (a secretaria marca quando o Pix chega) ----------
  rota('GET', /^\/api\/admin\/cadernos\/acessos$/, async () => {
    const alunos = db.prepare(`SELECT a.id, a.nome, m.serie, t.nome AS turma, c.plano
      FROM matriculas m JOIN alunos a ON a.id = m.aluno_id LEFT JOIN turmas t ON t.id = m.turma_id
      LEFT JOIN cad_acesso c ON c.aluno_id = a.id AND c.ano = m.ano_letivo
      WHERE m.ano_letivo = ? AND m.status = 'ativa' GROUP BY a.id ORDER BY a.nome`).all(Number(ANO_LETIVO));
    return { ano: ANO_LETIVO, planos: PLANOS, alunos };
  }, A);
  rota('PUT', /^\/api\/admin\/cadernos\/acessos\/(\d+)$/, async ({ params, body }) => {
    const id = Number(params[0]);
    if (!db.prepare('SELECT 1 FROM alunos WHERE id = ?').get(id)) throw new ErroHttp(404, 'Aluno não encontrado.');
    const plano = body.plano ? String(body.plano) : '';
    if (!plano) { db.prepare('DELETE FROM cad_acesso WHERE aluno_id = ? AND ano = ?').run(id, Number(ANO_LETIVO)); return { ok: true, plano: null }; }
    if (!PLANOS[plano]) throw new ErroHttp(400, 'Plano inválido.');
    db.prepare('INSERT INTO cad_acesso (aluno_id, ano, plano, em) VALUES (?,?,?,?) ON CONFLICT(aluno_id, ano) DO UPDATE SET plano = excluded.plano, em = excluded.em').run(id, Number(ANO_LETIVO), plano, new Date().toISOString());
    return { ok: true, plano };
  }, A);

  const entregar = (res, c, tipo) => {
    if (!/^[a-z0-9]+\/[a-z0-9-]+$/.test(c.arquivo) || !['pdf', 'html'].includes(tipo)) throw new ErroHttp(404, 'Não encontrado.');
    const arq = [path.join(PASTA, 'arquivos', c.arquivo + '.' + tipo), path.join(__dirname, 'arquivos', c.arquivo + '.' + tipo)].find((x) => fs.existsSync(x));
    if (!arq) throw new ErroHttp(404, 'Arquivo ainda não foi enviado.');
    const nome = `Caderno ${c.serie} - ${c.numero === 9 ? 'Maos que criam' : c.numero === 10 ? 'Alfabeto cursivo' : 'Unidade ' + c.numero}.${tipo}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]/g, '');
    res.writeHead(200, {
      // PDF: o leitor do navegador não abre o arquivo com X-Frame-Options/CSP restritivos; só o essencial
      ...(tipo === 'pdf' ? { 'X-Content-Type-Options': 'nosniff' } : CABECALHOS), 'Content-Type': tipo === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${nome}"`, 'Cache-Control': 'private, no-cache',
    });
    fs.createReadStream(arq).pipe(res);
    return undefined;
  };
  rota('GET', /^\/api\/admin\/cadernos\/arquivo\/(\d+)\/(pdf|html)$/, async ({ res, params }) => {
    const c = db.prepare('SELECT * FROM cadernos WHERE id = ?').get(Number(params[0]));
    if (!c) throw new ErroHttp(404, 'Não encontrado.');
    return entregar(res, c, params[1]);
  }, A);

  // ---------- família ----------
  const serieDoAluno = (alunoId) => {
    const m = db.prepare("SELECT serie FROM matriculas WHERE aluno_id = ? AND ano_letivo = ? AND status = 'ativa' ORDER BY id DESC LIMIT 1").get(Number(alunoId), Number(ANO_LETIVO));
    return m ? (m.serie || '') : null;
  };
  rota('GET', /^\/api\/pais\/cadernos\/(\d+)$/, async ({ params, pai }) => {
    if (!filhoDoPai(pai, params[0])) throw new ErroHttp(404, 'Aluno não encontrado.');
    const serie = serieDoAluno(params[0]);
    if (serie === null) return { ano: ANO_LETIVO, matriculado: false, bimestres: [] };
    // Só quem contratou o plano (marcado pela secretaria após o Pix) vê os cadernos. O texto usa o campo 'ano' da tela já existente.
    if (!planoDoAluno(params[0])) return { ano: `${ANO_LETIVO} (plano Conosco Digital)`, matriculado: false, bimestres: [] };
    const bim = datasBim(), hoje = hojeLocal();
    const lista = db.prepare('SELECT * FROM cadernos WHERE serie = ? AND ativo = 1 ORDER BY bimestre, numero').all(serie);
    const out = [];
    for (const n of [1, 2, 3, 4]) {
      const itens = lista.filter((c) => c.bimestre === n).map((c) => {
        const data = efetiva(c, bim);
        return { id: c.id, numero: c.numero, titulo: c.titulo, liberar_em: data, liberado: data <= hoje };
      });
      if (itens.length) out.push({ bimestre: n, cadernos: itens });
    }
    return { ano: ANO_LETIVO, matriculado: true, serie, bimestres: out };
  }, P);
  rota('GET', /^\/api\/pais\/cadernos\/(\d+)\/arquivo\/(\d+)\/(pdf|html)$/, async ({ res, params, pai }) => {
    if (!filhoDoPai(pai, params[0])) throw new ErroHttp(404, 'Não encontrado.');
    const serie = planoDoAluno(params[0]) ? serieDoAluno(params[0]) : null;
    const c = serie === null ? null : db.prepare('SELECT * FROM cadernos WHERE id = ? AND serie = ? AND ativo = 1').get(Number(params[1]), serie);
    if (!c || efetiva(c, datasBim()) > hojeLocal()) throw new ErroHttp(404, 'Este caderno ainda não foi liberado.');
    if (params[2] === 'pdf') {
      // registro e limite de downloads de PDF por família (dificulta repassar o material)
      const hoje = hojeLocal();
      const n = db.prepare('SELECT COUNT(*) n FROM cad_downloads WHERE responsavel_id = ? AND dia = ?').get(pai.id, hoje).n;
      if (n >= LIMITE_PDF_DIA) throw new ErroHttp(429, 'Limite diário de downloads atingido. Tente amanhã ou fale com a secretaria.');
      db.prepare('INSERT INTO cad_downloads (responsavel_id, aluno_id, caderno_id, dia, em) VALUES (?,?,?,?,?)').run(pai.id, Number(params[0]), c.id, hoje, new Date().toISOString());
    }
    return entregar(res, c, params[2]);
  }, P);
  rota('GET', /^\/api\/admin\/cadernos\/downloads$/, async () => ({
    por_familia: db.prepare("SELECT r.nome, r.whatsapp, COUNT(*) total, COUNT(DISTINCT d.dia) dias, MAX(d.em) ultimo, (SELECT COUNT(*) FROM pais_aparelhos a WHERE a.responsavel_id = r.id) aparelhos FROM cad_downloads d JOIN responsaveis r ON r.id = d.responsavel_id GROUP BY r.id ORDER BY total DESC").all(),
  }), A);
}

module.exports = { registrar };
