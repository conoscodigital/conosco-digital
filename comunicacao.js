// Agenda de comunicação: comunicados, recados, medicação, aviso do dia, equipe e portal dos pais.
const crypto = require('crypto');
const auth = require('./auth');

const hojeLocal = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const agoraIso = () => new Date().toISOString();
const dig = (s) => String(s || '').replace(/\D/g, '');
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
const PAPEIS = ['direcao', 'secretaria', 'coordenacao', 'professor', 'porteiro', 'cantina'];
const PORTARIAS = ['infantil', 'fundamental'];
const INTERNO = ['equipe', 'professores'];
const ALIM = ['Comeu tudo', 'Comeu bem', 'Comeu pouco', 'Não quis comer'];
const SONO = ['Não dormiu', 'Dormiu pouco', 'Dormiu bem'];
const HUMOR = ['Feliz', 'Calmo', 'Agitado', 'Choroso', 'Sonolento'];
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DURACAO_PAIS_MS = 30 * 24 * 3600 * 1000;

function normalizarHorarios(v) {
  const lista = String(v || '').toLowerCase().split(/[,;\s]+/).filter((x) => x && !['e', 'às', 'as', 'a', 'and'].includes(x)).map((h) => {
    const m = h.match(/^(\d{1,2})(?::|h)?(\d{2})?$/i);
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2] || 0);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  });
  if (!lista.length || lista.length > 8 || lista.includes(null)) return null;
  return [...new Set(lista)].sort().join(',');
}

function paisDaSessao(db, req) {
  const m = /(?:^|;\s*)pid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  db.prepare('DELETE FROM sessoes_pais WHERE expira_em < ?').run(agoraIso());
  const r = db.prepare('SELECT r.id, r.nome, r.whatsapp FROM sessoes_pais s JOIN responsaveis r ON r.id = s.responsavel_id WHERE s.token = ?').get(decodeURIComponent(m[1])) || null;
  if (!r) return null;
  try {
    const dm = /(?:^|;\s*)did=([A-Za-z0-9]{20,})/.exec(req.headers.cookie || '');
    if (!dm || !db.prepare('SELECT 1 FROM pais_aparelhos WHERE responsavel_id = ? AND did = ?').get(r.id, dm[1])) return null;
  } catch (e) { /* tabela criada no primeiro login */ }
  return r;
}

function registrar({ db, rota, A, ErroHttp, ESCOLA, ANO_LETIVO, BASE_URL, HTTPS, normalizarTelefone, transacao, ipDe, enviarJson }) {
  const E = { admin: true, equipe: true };      // direção, secretaria e professores
  const D = { admin: true, dir: true };          // só direção
  const P = { pais: true };                      // portal dos pais
  const PUSH = require('./push').criar(db, { contato: /^https:\/\//.test(BASE_URL || '') ? BASE_URL : `mailto:${process.env.ADMIN_EMAIL || 'admin@localhost'}` });
  const aviso = (ids, titulo, corpo) => PUSH.avisar(ids, { titulo, corpo, url: '/pais' });

  // ---------- consultas comuns ----------
  const MAT = `JOIN matriculas m ON m.aluno_id = a.id AND m.ano_letivo = ${Number(ANO_LETIVO)} AND m.status = 'ativa' JOIN planos p ON p.id = m.plano_id LEFT JOIN turmas t ON t.id = m.turma_id`;
  const turmasDoProfessor = (u) => db.prepare('SELECT turma_id FROM professor_turmas WHERE usuario_id = ?').all(u.id).map((r) => r.turma_id);
  const todos = (u) => u.papel !== 'professor';

  // alunos que o usuário da equipe pode ver
  function alunosVisiveis(u, extraWhere = '', par = []) {
    let w = 'a.ativo = 1 ' + extraWhere; const p = [...par];
    if (!todos(u)) {
      const ids = turmasDoProfessor(u);
      if (!ids.length) return [];
      w += ` AND m.turma_id IN (${ids.map(() => '?').join(',')})`; p.push(...ids);
    }
    return db.prepare(`SELECT a.id, a.nome, a.responsavel_id, p.etapa, m.turma_id, t.nome AS turma FROM alunos a ${MAT} WHERE ${w} ORDER BY a.nome COLLATE NOCASE`).all(...p);
  }
  function podeVerAluno(u, alunoId) {
    if (todos(u)) return !!db.prepare('SELECT 1 FROM alunos WHERE id = ?').get(alunoId);
    return alunosVisiveis(u, 'AND a.id = ?', [alunoId]).length > 0;
  }
  const filhosDe = (respId) => db.prepare(`SELECT a.id, a.nome, p.etapa, m.turma_id, t.nome AS turma FROM alunos a LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.ano_letivo = ${Number(ANO_LETIVO)} AND m.status = 'ativa' LEFT JOIN planos p ON p.id = m.plano_id LEFT JOIN turmas t ON t.id = m.turma_id WHERE a.responsavel_id = ? AND a.ativo = 1 ORDER BY a.nome COLLATE NOCASE`).all(respId);

  // ---------- comunicados ----------
  function destinatarios(c) {
    if (c.alvo_tipo === 'equipe') return db.prepare('SELECT id FROM usuarios WHERE ativo = 1 AND id != ?').all(c.usuario_id || 0).map((r) => r.id);
    if (c.alvo_tipo === 'professores') return db.prepare("SELECT id FROM usuarios WHERE ativo = 1 AND papel = 'professor' AND id != ?").all(c.usuario_id || 0).map((r) => r.id);
    let w = 'a.ativo = 1'; const p = [];
    if (c.alvo_tipo === 'etapa') { w += ' AND p.etapa = ?'; p.push(c.alvo_valor); }
    if (c.alvo_tipo === 'turma') { w += ' AND m.turma_id = ?'; p.push(Number(c.alvo_valor)); }
    if (c.alvo_tipo === 'aluno') { w += ' AND a.id = ?'; p.push(Number(c.alvo_valor)); }
    return [...new Set(db.prepare(`SELECT a.responsavel_id FROM alunos a ${MAT} WHERE ${w}`).all(...p).map((r) => r.responsavel_id))];
  }
  function rotuloAlvo(c) {
    if (c.alvo_tipo === 'escola') return 'Toda a escola';
    if (c.alvo_tipo === 'equipe') return 'Toda a equipe';
    if (c.alvo_tipo === 'professores') return 'Professores';
    if (c.alvo_tipo === 'etapa') return c.alvo_valor;
    if (c.alvo_tipo === 'turma') return 'Turma ' + (db.prepare('SELECT nome FROM turmas WHERE id = ?').get(Number(c.alvo_valor))?.nome || '?');
    return 'Aluno: ' + (db.prepare('SELECT nome FROM alunos WHERE id = ?').get(Number(c.alvo_valor))?.nome || '?');
  }

  rota('GET', /^\/api\/equipe\/alvos$/, async ({ usuario }) => {
    const turmas = todos(usuario)
      ? db.prepare('SELECT id, nome FROM turmas WHERE ativo = 1 AND ano_letivo = ? ORDER BY nome').all(ANO_LETIVO)
      : db.prepare('SELECT t.id, t.nome FROM turmas t JOIN professor_turmas pt ON pt.turma_id = t.id WHERE pt.usuario_id = ? AND t.ativo = 1 ORDER BY t.nome').all(usuario.id);
    return {
      escola: todos(usuario),
      etapas: todos(usuario) ? db.prepare('SELECT DISTINCT etapa FROM planos WHERE ativo = 1 ORDER BY etapa').all().map((r) => r.etapa) : [],
      turmas,
      alunos: alunosVisiveis(usuario).map((a) => ({ id: a.id, nome: a.nome, turma: a.turma })),
    };
  }, E);

  rota('GET', /^\/api\/equipe\/painel$/, async ({ usuario }) => {
    const ids = alunosVisiveis(usuario).map((a) => a.id);
    const inn = ids.length ? ids.map(() => '?').join(',') : 'NULL';
    const hoje = hojeLocal();
    return {
      recadosNovos: db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE de = 'pais' AND lida = 0 AND aluno_id IN (${inn})`).get(...ids).n,
      medicacoesNovas: db.prepare(`SELECT COUNT(*) AS n FROM medicacoes WHERE status = 'ativa' AND visto_em IS NULL AND aluno_id IN (${inn})`).get(...ids).n,
      muralNovos: muralDe(usuario).filter((c) => !c.lido).length,
      medicacoesHoje: db.prepare(`SELECT COUNT(*) AS n FROM medicacoes WHERE status = 'ativa' AND inicio <= ? AND (fim IS NULL OR fim >= ?) AND aluno_id IN (${inn})`).get(hoje, hoje, ...ids).n,
    };
  }, E);

  rota('GET', /^\/api\/equipe\/comunicados$/, async ({ usuario }) => {
    const lista = db.prepare('SELECT * FROM comunicados ORDER BY id DESC LIMIT 100').all();
    const out = [];
    for (const c of lista) {
      if (!todos(usuario) && c.usuario_id !== usuario.id) continue; // professor vê só os próprios
      const dest = destinatarios(c);
      const lidos = db.prepare(`SELECT COUNT(*) AS n FROM ${INTERNO.includes(c.alvo_tipo) ? 'comunicado_lidos_equipe' : 'comunicado_lidos'} WHERE comunicado_id = ?`).get(c.id).n;
      out.push({ id: c.id, autor: c.autor, titulo: c.titulo, texto: c.texto, criado_em: c.criado_em, alvo: rotuloAlvo(c), destinatarios: dest.length, lidos });
    }
    return out;
  }, E);

  rota('POST', /^\/api\/equipe\/comunicados$/, async ({ body, usuario }) => {
    const tipo = String(body.alvo_tipo || '');
    if (!['escola', 'etapa', 'turma', 'aluno', ...INTERNO].includes(tipo)) throw new ErroHttp(400, 'Escolha para quem vai o comunicado.');
    const titulo = txt(body.titulo, 120), texto = txt(body.texto, 3000);
    if (!titulo || !texto) throw new ErroHttp(400, 'Preencha o título e a mensagem.');
    let valor = tipo === 'escola' || INTERNO.includes(tipo) ? null : String(body.alvo_valor ?? '');
    if (tipo === 'escola' || tipo === 'etapa' || INTERNO.includes(tipo)) {
      if (!todos(usuario)) throw new ErroHttp(403, 'Professores enviam só para suas turmas ou alunos.');
      if (tipo === 'etapa' && !db.prepare('SELECT 1 FROM planos WHERE etapa = ?').get(valor)) throw new ErroHttp(400, 'Etapa inválida.');
    }
    if (tipo === 'turma') {
      const t = Number(valor);
      if (!db.prepare('SELECT 1 FROM turmas WHERE id = ?').get(t)) throw new ErroHttp(400, 'Turma inválida.');
      if (!todos(usuario) && !turmasDoProfessor(usuario).includes(t)) throw new ErroHttp(403, 'Você não leciona nesta turma.');
      valor = String(t);
    }
    if (tipo === 'aluno') {
      const a = Number(valor);
      if (!podeVerAluno(usuario, a)) throw new ErroHttp(403, 'Aluno não encontrado nas suas turmas.');
      valor = String(a);
    }
    const c = { alvo_tipo: tipo, alvo_valor: valor };
    if (!destinatarios(c).length) throw new ErroHttp(400, INTERNO.includes(tipo) ? 'Não há outros usuários da equipe nesse destino. Cadastre-os em Equipe.' : 'Não há famílias com matrícula ativa nesse destino.');
    const r = db.prepare('INSERT INTO comunicados (usuario_id, autor, alvo_tipo, alvo_valor, titulo, texto, criado_em) VALUES (?,?,?,?,?,?,?)').run(usuario.id, usuario.nome, tipo, valor, titulo, texto, agoraIso());
    const dest = destinatarios(c);
    if (!INTERNO.includes(tipo)) aviso(dest, ESCOLA, `Novo comunicado: ${titulo}`);
    return { id: Number(r.lastInsertRowid), destinatarios: dest.length };
  }, E);

  rota('POST', /^\/api\/equipe\/comunicados\/(\d+)\/apagar$/, async ({ params, usuario }) => {
    const c = db.prepare('SELECT * FROM comunicados WHERE id = ?').get(Number(params[0]));
    if (!c) throw new ErroHttp(404, 'Não encontrado.');
    if (!todos(usuario) && c.usuario_id !== usuario.id) throw new ErroHttp(403, 'Só o autor pode apagar.');
    db.prepare('DELETE FROM comunicados WHERE id = ?').run(c.id);
    return { ok: true };
  }, E);

  // ---------- mural da equipe (comunicados internos) ----------
  function muralDe(u) {
    const lidos = new Set(db.prepare('SELECT comunicado_id FROM comunicado_lidos_equipe WHERE usuario_id = ?').all(u.id).map((r) => r.comunicado_id));
    return db.prepare("SELECT * FROM comunicados WHERE alvo_tipo IN ('equipe','professores') ORDER BY id DESC LIMIT 100").all()
      .filter((c) => c.usuario_id !== u.id && (c.alvo_tipo === 'equipe' || u.papel === 'professor'))
      .map((c) => ({ id: c.id, titulo: c.titulo, texto: c.texto, autor: c.autor, criado_em: c.criado_em, para: rotuloAlvo(c), lido: lidos.has(c.id) }));
  }
  rota('GET', /^\/api\/equipe\/mural$/, async ({ usuario }) => muralDe(usuario), E);
  rota('POST', /^\/api\/equipe\/mural\/lidos$/, async ({ usuario }) => {
    const ins = db.prepare('INSERT OR IGNORE INTO comunicado_lidos_equipe (comunicado_id, usuario_id, lido_em) VALUES (?,?,?)');
    for (const c of muralDe(usuario)) if (!c.lido) ins.run(c.id, usuario.id, agoraIso());
    return { ok: true };
  }, E);

  // ---------- recados (conversa por aluno) ----------
  rota('GET', /^\/api\/equipe\/conversas$/, async ({ usuario }) => {
    const vis = new Map(alunosVisiveis(usuario).map((a) => [a.id, a]));
    const linhas = db.prepare(`SELECT aluno_id, MAX(id) AS ultimo_id, SUM(CASE WHEN de = 'pais' AND lida = 0 THEN 1 ELSE 0 END) AS novas FROM mensagens GROUP BY aluno_id ORDER BY ultimo_id DESC`).all();
    return linhas.filter((l) => vis.has(l.aluno_id)).map((l) => {
      const u = db.prepare('SELECT texto, de, criado_em FROM mensagens WHERE id = ?').get(l.ultimo_id);
      const a = vis.get(l.aluno_id);
      return { aluno_id: l.aluno_id, aluno: a.nome, turma: a.turma, novas: l.novas, ultimo: u.texto.slice(0, 120), de: u.de, quando: u.criado_em };
    });
  }, E);

  rota('GET', /^\/api\/equipe\/conversas\/(\d+)$/, async ({ params, usuario }) => {
    const id = Number(params[0]);
    if (!podeVerAluno(usuario, id)) throw new ErroHttp(403, 'Sem acesso a este aluno.');
    db.prepare("UPDATE mensagens SET lida = 1 WHERE aluno_id = ? AND de = 'pais'").run(id);
    const a = db.prepare('SELECT a.nome, r.nome AS responsavel, r.whatsapp FROM alunos a JOIN responsaveis r ON r.id = a.responsavel_id WHERE a.id = ?').get(id);
    const msgs = db.prepare('SELECT ms.id, ms.de, ms.texto, ms.criado_em, ms.autor, r.nome AS responsavel FROM mensagens ms LEFT JOIN responsaveis r ON r.id = ms.responsavel_id WHERE ms.aluno_id = ? ORDER BY ms.id').all(id);
    return { aluno: a.nome, responsavel: a.responsavel, whatsapp: a.whatsapp, mensagens: msgs };
  }, E);

  rota('POST', /^\/api\/equipe\/conversas\/(\d+)$/, async ({ params, body, usuario }) => {
    const id = Number(params[0]);
    if (!podeVerAluno(usuario, id)) throw new ErroHttp(403, 'Sem acesso a este aluno.');
    const t = txt(body.texto, 2000);
    if (!t) throw new ErroHttp(400, 'Escreva a mensagem.');
    db.prepare("INSERT INTO mensagens (aluno_id, de, usuario_id, autor, texto, criado_em) VALUES (?, 'escola', ?, ?, ?, ?)").run(id, usuario.id, usuario.nome, t, agoraIso());
    aviso([db.prepare('SELECT responsavel_id FROM alunos WHERE id = ?').get(id)?.responsavel_id], ESCOLA, 'Você recebeu um recado da escola.');
    return { ok: true };
  }, E);

  // ---------- medicação (equipe) ----------
  rota('GET', /^\/api\/equipe\/medicacao$/, async ({ url, usuario }) => {
    const data = url.searchParams.get('data') || hojeLocal();
    if (!dataValida(data)) throw new ErroHttp(400, 'Data inválida.');
    const vis = new Map(alunosVisiveis(usuario).map((a) => [a.id, a]));
    const meds = db.prepare("SELECT * FROM medicacoes WHERE status = 'ativa' AND inicio <= ? AND (fim IS NULL OR fim >= ?) ORDER BY id").all(data, data).filter((m) => vis.has(m.aluno_id));
    const doses = db.prepare('SELECT * FROM medicacao_doses WHERE data = ?').all(data);
    const lista = meds.map((m) => {
      const a = vis.get(m.aluno_id);
      return {
        id: m.id, aluno_id: m.aluno_id, aluno: a.nome, turma: a.turma, remedio: m.remedio, dose: m.dose, obs: m.obs, inicio: m.inicio, fim: m.fim, nova: !m.visto_em,
        horarios: m.horarios.split(',').map((h) => { const d = doses.find((x) => x.medicacao_id === m.id && x.horario === h); return { horario: h, feito: !!d, por: d?.autor || null, quando: d?.feito_em || null }; }),
      };
    });
    return { data, lista };
  }, E);

  rota('POST', /^\/api\/equipe\/medicacao\/(\d+)\/visto$/, async ({ params, usuario }) => {
    const m = db.prepare('SELECT * FROM medicacoes WHERE id = ?').get(Number(params[0]));
    if (!m || !podeVerAluno(usuario, m.aluno_id)) throw new ErroHttp(404, 'Não encontrado.');
    db.prepare('UPDATE medicacoes SET visto_em = COALESCE(visto_em, ?) WHERE id = ?').run(agoraIso(), m.id);
    return { ok: true };
  }, E);

  rota('POST', /^\/api\/equipe\/medicacao\/(\d+)\/dose$/, async ({ params, body, usuario }) => {
    const m = db.prepare('SELECT * FROM medicacoes WHERE id = ?').get(Number(params[0]));
    if (!m || !podeVerAluno(usuario, m.aluno_id)) throw new ErroHttp(404, 'Não encontrado.');
    const data = String(body.data || hojeLocal());
    if (!dataValida(data)) throw new ErroHttp(400, 'Data inválida.');
    const h = String(body.horario || '');
    if (!m.horarios.split(',').includes(h)) throw new ErroHttp(400, 'Horário inválido.');
    if (body.feito === false) db.prepare('DELETE FROM medicacao_doses WHERE medicacao_id = ? AND data = ? AND horario = ?').run(m.id, data, h);
    else {
      db.prepare('INSERT OR REPLACE INTO medicacao_doses (medicacao_id, data, horario, usuario_id, autor, feito_em) VALUES (?,?,?,?,?,?)').run(m.id, data, h, usuario.id, usuario.nome, agoraIso());
      db.prepare('UPDATE medicacoes SET visto_em = COALESCE(visto_em, ?) WHERE id = ?').run(agoraIso(), m.id);
    }
    return { ok: true };
  }, E);

  // ---------- aviso do dia ----------
  rota('GET', /^\/api\/equipe\/aviso-dia$/, async ({ url, usuario }) => {
    const turma = Number(url.searchParams.get('turma')) || 0;
    const data = url.searchParams.get('data') || hojeLocal();
    if (!dataValida(data)) throw new ErroHttp(400, 'Data inválida.');
    if (!turma) return { data, alunos: [], opcoes: { alimentacao: ALIM, sono: SONO, humor: HUMOR } };
    if (!todos(usuario) && !turmasDoProfessor(usuario).includes(turma)) throw new ErroHttp(403, 'Você não leciona nesta turma.');
    const alunos = alunosVisiveis(usuario, 'AND m.turma_id = ?', [turma]).map((a) => {
      const r = db.prepare('SELECT alimentacao, sono, humor, obs FROM avisos_dia WHERE aluno_id = ? AND data = ?').get(a.id, data) || {};
      return { id: a.id, nome: a.nome, ...r };
    });
    return { data, alunos, opcoes: { alimentacao: ALIM, sono: SONO, humor: HUMOR } };
  }, E);

  rota('PUT', /^\/api\/equipe\/aviso-dia$/, async ({ body, usuario }) => {
    const aluno = Number(body.aluno_id);
    if (!podeVerAluno(usuario, aluno)) throw new ErroHttp(403, 'Sem acesso a este aluno.');
    const data = String(body.data || hojeLocal());
    if (!dataValida(data)) throw new ErroHttp(400, 'Data inválida.');
    const pick = (v, lista) => (lista.includes(v) ? v : null);
    db.prepare(`INSERT INTO avisos_dia (aluno_id, data, alimentacao, sono, humor, obs, autor, atualizado_em) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(aluno_id, data) DO UPDATE SET alimentacao=excluded.alimentacao, sono=excluded.sono, humor=excluded.humor, obs=excluded.obs, autor=excluded.autor, atualizado_em=excluded.atualizado_em`)
      .run(aluno, data, pick(body.alimentacao, ALIM), pick(body.sono, SONO), pick(body.humor, HUMOR), txt(body.obs, 500) || null, usuario.nome, agoraIso());
    return { ok: true };
  }, E);

  // ---------- gestão da equipe (direção) ----------
  rota('GET', /^\/api\/equipe\/usuarios$/, async () => {
    return db.prepare('SELECT id, nome, email, papel, ativo, nascimento, whatsapp, portaria FROM usuarios ORDER BY nome COLLATE NOCASE').all().map((u) => ({
      ...u, turmas: db.prepare('SELECT turma_id FROM professor_turmas WHERE usuario_id = ?').all(u.id).map((r) => r.turma_id),
    }));
  }, D);

  function dadosPessoais(body) {
    const nasc = txt(body.nascimento, 10) || null;
    if (nasc && (!/^\d{4}-\d{2}-\d{2}$/.test(nasc) || Number.isNaN(Date.parse(nasc)))) throw new ErroHttp(400, 'Data de nascimento inválida.');
    const w = String(body.whatsapp || '').replace(/\D/g, '');
    if (w && (w.length < 10 || w.length > 13)) throw new ErroHttp(400, 'WhatsApp inválido. Use DDD + número.');
    return { nasc, w: w || null };
  }
  function turmasValidas(lista) {
    return [...new Set((Array.isArray(lista) ? lista : []).map(Number))].filter((id) => db.prepare('SELECT 1 FROM turmas WHERE id = ?').get(id));
  }
  rota('POST', /^\/api\/equipe\/usuarios$/, async ({ body }) => {
    const nome = txt(body.nome, 100), email = txt(body.email, 120).toLowerCase(), senha = String(body.senha || '');
    if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroHttp(400, 'Informe nome e e-mail válidos.');
    if (senha.length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
    const papel = PAPEIS.includes(body.papel) ? body.papel : 'professor';
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroHttp(409, 'Já existe um usuário com esse e-mail.');
    const { nasc, w } = dadosPessoais(body);
    transacao(db, () => {
      const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, criado_em, papel, ativo, nascimento, whatsapp, portaria) VALUES (?,?,?,?,?,1,?,?,?)').run(nome, email, auth.hashSenha(senha), agoraIso(), papel, nasc, w, papel === 'porteiro' && PORTARIAS.includes(body.portaria) ? body.portaria : null);
      if (papel === 'professor') for (const t of turmasValidas(body.turmas)) db.prepare('INSERT OR IGNORE INTO professor_turmas (usuario_id, turma_id) VALUES (?,?)').run(Number(r.lastInsertRowid), t);
    });
    return { ok: true };
  }, D);

  rota('PUT', /^\/api\/equipe\/usuarios\/(\d+)$/, async ({ params, body, usuario }) => {
    const id = Number(params[0]);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!u) throw new ErroHttp(404, 'Usuário não encontrado.');
    const papel = PAPEIS.includes(body.papel) ? body.papel : u.papel;
    const ativo = body.ativo === false ? 0 : 1;
    if (id === usuario.id && (papel !== 'direcao' || !ativo)) throw new ErroHttp(400, 'Você não pode tirar o próprio acesso de direção.');
    const nome = txt(body.nome, 100) || u.nome;
    const { nasc, w } = dadosPessoais(body);
    transacao(db, () => {
      db.prepare('UPDATE usuarios SET nome = ?, papel = ?, ativo = ?, nascimento = ?, whatsapp = ?, portaria = ? WHERE id = ?').run(nome, papel, ativo, nasc, w, papel === 'porteiro' && PORTARIAS.includes(body.portaria) ? body.portaria : null, id);
      db.prepare('DELETE FROM professor_turmas WHERE usuario_id = ?').run(id);
      if (papel === 'professor') for (const t of turmasValidas(body.turmas)) db.prepare('INSERT OR IGNORE INTO professor_turmas (usuario_id, turma_id) VALUES (?,?)').run(id, t);
      if (body.senha) {
        if (String(body.senha).length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
        db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(auth.hashSenha(String(body.senha)), id);
      }
      if (!ativo || body.senha) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
    });
    return { ok: true };
  }, D);

  // ---------- acesso dos pais (secretaria gera o código) ----------
  rota('GET', /^\/api\/admin\/responsaveis\/(\d+)\/acesso$/, async ({ params }) => {
    const a = db.prepare('SELECT criado_em FROM acessos_pais WHERE responsavel_id = ?').get(Number(params[0]));
    return { tem: !!a, criado_em: a?.criado_em || null };
  }, A);

  // Código criado para a mensagem de boas-vindas: fica guardado só até o primeiro uso, para repetir o mesmo em cada mensagem.
  db.exec(`CREATE TABLE IF NOT EXISTS acessos_aguardando (
    responsavel_id INTEGER PRIMARY KEY REFERENCES responsaveis(id) ON DELETE CASCADE,
    codigo TEXT NOT NULL,
    criado_em TEXT NOT NULL
  )`);
  function gravarCodigoPais(id) {
    let codigo = '';
    for (let i = 0; i < 6; i++) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
    db.prepare('INSERT INTO acessos_pais (responsavel_id, codigo_hash, criado_em) VALUES (?,?,?) ON CONFLICT(responsavel_id) DO UPDATE SET codigo_hash = excluded.codigo_hash, criado_em = excluded.criado_em').run(id, auth.hashSenha(codigo), agoraIso());
    return `${codigo.slice(0, 3)}-${codigo.slice(3)}`;
  }
  // Devolve o código para a boas-vindas. Quem já tem acesso recebe null: o código dele nunca é trocado aqui.
  function acessoParaBoasVindas(id) {
    const aguardando = db.prepare('SELECT codigo FROM acessos_aguardando WHERE responsavel_id = ?').get(id);
    if (aguardando) return aguardando.codigo;
    if (db.prepare('SELECT 1 FROM acessos_pais WHERE responsavel_id = ?').get(id)) return null;
    return transacao(db, () => {
      const codigo = gravarCodigoPais(id);
      db.prepare('INSERT INTO acessos_aguardando (responsavel_id, codigo, criado_em) VALUES (?,?,?)').run(id, codigo, agoraIso());
      return codigo;
    });
  }

  rota('POST', /^\/api\/admin\/responsaveis\/(\d+)\/acesso$/, async ({ params }) => {
    const id = Number(params[0]);
    const r = db.prepare('SELECT * FROM responsaveis WHERE id = ?').get(id);
    if (!r) throw new ErroHttp(404, 'Responsável não encontrado.');
    if (!r.whatsapp) throw new ErroHttp(400, 'Cadastre o WhatsApp do responsável antes de gerar o acesso.');
    const bonito = gravarCodigoPais(id);
    db.prepare('DELETE FROM acessos_aguardando WHERE responsavel_id = ?').run(id);
    db.prepare('DELETE FROM sessoes_pais WHERE responsavel_id = ?').run(id);
    try { db.prepare('DELETE FROM pais_aparelhos WHERE responsavel_id = ?').run(id); } catch (e) { /* tabela ainda não criada */ }
    const link = `${BASE_URL || ''}/pais`;
    const msg = `Olá, ${r.nome.split(' ')[0]}! 😊\nAqui está o seu acesso ao portal do ${ESCOLA}, onde você recebe os comunicados, fala com a escola e registra medicação do seu filho(a).\n\nLink: ${link}\nSeu WhatsApp: ${r.whatsapp}\nSeu código: ${bonito}\n\nGuarde este código com carinho. 🧡`;
    return { codigo: bonito, link, wa_url: `https://wa.me/${normalizarTelefone(r.whatsapp)}?text=${encodeURIComponent(msg)}` };
  }, A);

  // ---------- portal dos pais ----------
  rota('POST', /^\/api\/pais\/login$/, async ({ req, body, res }) => {
    const ip = 'p:' + ipDe(req);
    if (auth.loginBloqueado(ip)) throw new ErroHttp(429, 'Muitas tentativas. Aguarde 15 minutos.');
    const num = dig(body.whatsapp), codigo = String(body.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let achado = null;
    if (num.length >= 8 && codigo.length === 6) {
      const cand = db.prepare('SELECT r.id, r.whatsapp, a.codigo_hash FROM acessos_pais a JOIN responsaveis r ON r.id = a.responsavel_id').all()
        .filter((c) => dig(c.whatsapp).slice(-8) === num.slice(-8));
      achado = cand.find((c) => auth.conferirSenha(codigo, c.codigo_hash)) || null;
    }
    if (!achado) { auth.registrarFalha(ip); throw new ErroHttp(401, 'WhatsApp ou código incorretos. Peça um novo código à secretaria.'); }
    auth.limparFalhas(ip);
    db.prepare('DELETE FROM acessos_aguardando WHERE responsavel_id = ?').run(achado.id);
    // limite: 2 aparelhos por família, 1 sessão ativa por vez
    db.exec('CREATE TABLE IF NOT EXISTS pais_aparelhos (responsavel_id INTEGER NOT NULL, did TEXT NOT NULL, criado_em TEXT NOT NULL, PRIMARY KEY (responsavel_id, did))');
    const dm = /(?:^|;\s*)did=([A-Za-z0-9]{20,})/.exec(req.headers.cookie || '');
    let did = dm ? dm[1] : null;
    const regs = db.prepare('SELECT did FROM pais_aparelhos WHERE responsavel_id = ?').all(achado.id).map((x) => x.did);
    if (!did || !regs.includes(did)) {
      if (regs.length >= 2) throw new ErroHttp(403, 'Esta conta já está em uso em 2 aparelhos. Para trocar de aparelho, peça à secretaria para liberar.');
      did = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO pais_aparelhos (responsavel_id, did, criado_em) VALUES (?,?,?)').run(achado.id, did, agoraIso());
    }
    db.prepare('DELETE FROM sessoes_pais WHERE responsavel_id = ?').run(achado.id);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessoes_pais (token, responsavel_id, expira_em) VALUES (?,?,?)').run(token, achado.id, new Date(Date.now() + DURACAO_PAIS_MS).toISOString());
    enviarJson(res, 200, { ok: true }, { 'Set-Cookie': [`pid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACAO_PAIS_MS / 1000}${HTTPS ? '; Secure' : ''}`, `did=${did}; HttpOnly; SameSite=Lax; Path=/; Max-Age=63072000${HTTPS ? '; Secure' : ''}`] });
    return undefined;
  });

  rota('POST', /^\/api\/pais\/logout$/, async ({ req, res }) => {
    const m = /(?:^|;\s*)pid=([^;]+)/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessoes_pais WHERE token = ?').run(decodeURIComponent(m[1]));
    enviarJson(res, 200, { ok: true }, { 'Set-Cookie': `pid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${HTTPS ? '; Secure' : ''}` });
    return undefined;
  });

  function comunicadosDoPai(pai) {
    const filhos = filhosDe(pai.id);
    const etapas = new Set(filhos.map((f) => f.etapa).filter(Boolean)), turmas = new Set(filhos.map((f) => String(f.turma_id)).filter((x) => x !== 'null')), ids = new Set(filhos.map((f) => String(f.id)));
    const lidos = new Set(db.prepare('SELECT comunicado_id FROM comunicado_lidos WHERE responsavel_id = ?').all(pai.id).map((r) => r.comunicado_id));
    return db.prepare('SELECT * FROM comunicados ORDER BY id DESC LIMIT 300').all()
      .filter((c) => c.alvo_tipo === 'escola' || (c.alvo_tipo === 'etapa' && etapas.has(c.alvo_valor)) || (c.alvo_tipo === 'turma' && turmas.has(c.alvo_valor)) || (c.alvo_tipo === 'aluno' && ids.has(c.alvo_valor)))
      .map((c) => ({ id: c.id, titulo: c.titulo, texto: c.texto, autor: c.autor, criado_em: c.criado_em, lido: lidos.has(c.id) }));
  }
  const filhoDoPai = (pai, id) => filhosDe(pai.id).find((f) => f.id === Number(id));

  rota('GET', /^\/api\/pais\/me$/, async ({ pai }) => {
    const filhos = filhosDe(pai.id);
    const ids = filhos.map((f) => f.id), inn = ids.length ? ids.map(() => '?').join(',') : 'NULL';
    return {
      nome: pai.nome, escola: ESCOLA, filhos,
      novosComunicados: comunicadosDoPai(pai).filter((c) => !c.lido).length,
      novasMensagens: db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE de = 'escola' AND lida = 0 AND aluno_id IN (${inn})`).get(...ids).n,
    };
  }, P);

  rota('GET', /^\/api\/pais\/push\/chave$/, async () => ({ chave: PUSH.chavePublica }), P);
  rota('POST', /^\/api\/pais\/push\/inscrever$/, async ({ body, pai }) => {
    if (!PUSH.inscrever(pai.id, body.inscricao)) throw new ErroHttp(400, 'Inscrição inválida.');
    return { ok: true };
  }, P);
  rota('POST', /^\/api\/pais\/push\/teste$/, async ({ pai }) => ({
    resultados: await PUSH.testar(pai.id, { titulo: ESCOLA, corpo: 'Teste: os avisos estão funcionando neste aparelho. 🎉', url: '/pais' }),
  }), P);
  rota('POST', /^\/api\/pais\/push\/cancelar$/, async ({ body, pai }) => { PUSH.cancelar(pai.id, body.endpoint); return { ok: true }; }, P);
  rota('GET', /^\/api\/pais\/comunicados$/, async ({ pai }) => comunicadosDoPai(pai), P);
  rota('POST', /^\/api\/pais\/comunicados\/(\d+)\/lido$/, async ({ params, pai }) => {
    if (comunicadosDoPai(pai).some((c) => c.id === Number(params[0]))) db.prepare('INSERT OR IGNORE INTO comunicado_lidos (comunicado_id, responsavel_id, lido_em) VALUES (?,?,?)').run(Number(params[0]), pai.id, agoraIso());
    return { ok: true };
  }, P);

  rota('GET', /^\/api\/pais\/mensagens\/(\d+)$/, async ({ params, pai }) => {
    const f = filhoDoPai(pai, params[0]);
    if (!f) throw new ErroHttp(404, 'Aluno não encontrado.');
    db.prepare("UPDATE mensagens SET lida = 1 WHERE aluno_id = ? AND de = 'escola'").run(f.id);
    return db.prepare('SELECT id, de, texto, criado_em, autor FROM mensagens WHERE aluno_id = ? ORDER BY id').all(f.id);
  }, P);
  rota('POST', /^\/api\/pais\/mensagens\/(\d+)$/, async ({ params, body, pai }) => {
    const f = filhoDoPai(pai, params[0]);
    if (!f) throw new ErroHttp(404, 'Aluno não encontrado.');
    const t = txt(body.texto, 2000);
    if (!t) throw new ErroHttp(400, 'Escreva a mensagem.');
    db.prepare("INSERT INTO mensagens (aluno_id, de, responsavel_id, autor, texto, criado_em) VALUES (?, 'pais', ?, ?, ?, ?)").run(f.id, pai.id, pai.nome, t, agoraIso());
    return { ok: true };
  }, P);

  rota('GET', /^\/api\/pais\/medicacoes\/(\d+)$/, async ({ params, pai }) => {
    const f = filhoDoPai(pai, params[0]);
    if (!f) throw new ErroHttp(404, 'Aluno não encontrado.');
    const hoje = hojeLocal();
    return db.prepare("SELECT * FROM medicacoes WHERE aluno_id = ? AND status = 'ativa' AND (fim IS NULL OR fim >= ?) ORDER BY id DESC").all(f.id, hoje).map((m) => {
      const doses = db.prepare('SELECT horario, feito_em, autor FROM medicacao_doses WHERE medicacao_id = ? AND data = ?').all(m.id, hoje);
      return { id: m.id, remedio: m.remedio, dose: m.dose, horarios: m.horarios.split(','), inicio: m.inicio, fim: m.fim, obs: m.obs, visto: !!m.visto_em, hoje: doses };
    });
  }, P);
  rota('POST', /^\/api\/pais\/medicacoes\/(\d+)$/, async ({ params, body, pai }) => {
    const f = filhoDoPai(pai, params[0]);
    if (!f) throw new ErroHttp(404, 'Aluno não encontrado.');
    const remedio = txt(body.remedio, 100), dose = txt(body.dose, 100), horarios = normalizarHorarios(body.horarios);
    if (!remedio || !dose) throw new ErroHttp(400, 'Informe o remédio e a dose.');
    if (!horarios) throw new ErroHttp(400, 'Informe os horários, por exemplo: 08:00 e 14:00.');
    const inicio = String(body.inicio || hojeLocal()), fim = body.fim ? String(body.fim) : null;
    if (!dataValida(inicio) || (fim && (!dataValida(fim) || fim < inicio))) throw new ErroHttp(400, 'Confira as datas de início e fim.');
    db.prepare('INSERT INTO medicacoes (aluno_id, responsavel_id, remedio, dose, horarios, inicio, fim, obs, criado_em) VALUES (?,?,?,?,?,?,?,?,?)').run(f.id, pai.id, remedio, dose, horarios, inicio, fim, txt(body.obs, 300) || null, agoraIso());
    return { ok: true };
  }, P);
  rota('POST', /^\/api\/pais\/medicacoes\/(\d+)\/encerrar$/, async ({ params, pai }) => {
    const m = db.prepare('SELECT * FROM medicacoes WHERE id = ?').get(Number(params[0]));
    if (!m || !filhoDoPai(pai, m.aluno_id)) throw new ErroHttp(404, 'Não encontrado.');
    db.prepare("UPDATE medicacoes SET status = 'encerrada' WHERE id = ?").run(m.id);
    return { ok: true };
  }, P);

  registrar.ctx = { alunosVisiveis, podeVerAluno, turmasDoProfessor, todos, filhoDoPai, filhosDe, aviso, acessoParaBoasVindas };

  rota('GET', /^\/api\/pais\/aviso-dia\/(\d+)$/, async ({ params, pai }) => {
    const f = filhoDoPai(pai, params[0]);
    if (!f) throw new ErroHttp(404, 'Aluno não encontrado.');
    return db.prepare('SELECT data, alimentacao, sono, humor, obs, autor FROM avisos_dia WHERE aluno_id = ? ORDER BY data DESC LIMIT 14').all(f.id);
  }, P);
}

module.exports = { registrar, paisDaSessao, normalizarHorarios, ctx: () => registrar.ctx };
