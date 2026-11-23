// Painel: cadernos de atividades (data de liberação por bimestre e por caderno).
async function telaCadernos() {
  const r = await api('GET', '/api/admin/cadernos');
  const ac = await api('GET', '/api/admin/cadernos/acessos');
  const fmt = (d) => (d ? d.split('-').reverse().join('/') : '');
  const series = [...new Set(r.cadernos.map((c) => c.serie))];
  const bims = [1, 2, 3, 4];
  $('view').innerHTML = `    <div class="card"><h3 style="margin-top:0">Quem pagou o plano Conosco Digital</h3>
      <p class="muted">Quando o Pix chegar, escolha o plano do aluno. Só os alunos marcados veem os cadernos no portal. Depois, envie o código de acesso à família pelo botão de sempre.</p>
      <input type="search" id="cb-busca" placeholder="Buscar aluno" style="max-width:320px">
      <div class="tabela"><table><thead><tr><th>Aluno</th><th>Série / turma</th><th>Plano</th></tr></thead><tbody id="cb-ac">
      ${ac.alunos.map((a) => `<tr data-aluno="${a.id}" data-nome="${esc(a.nome.toLowerCase())}"><td><strong>${esc(a.nome)}</strong></td><td>${esc(a.serie || '')} ${a.turma ? '· ' + esc(a.turma) : ''}</td><td><select class="cb-plano"><option value="">Não contratou</option>${Object.entries(ac.planos).map(([k, v]) => `<option value="${k}" ${a.plano === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table></div><div class="muted">${ac.alunos.filter((a) => a.plano).length} de ${ac.alunos.length} alunos com acesso liberado.</div></div>
    <div class="card"><h3 style="margin-top:0">Cadernos de atividades ${r.ano}</h3>
    <p class="muted">A família vê no portal só os cadernos que já foram liberados, da série do filho. Cada bimestre libera dois cadernos por vez. Defina abaixo a data em que cada bimestre é liberado.</p>
    <div class="grid">${bims.map((n) => `<label>${n}º bimestre libera em<input type="date" id="cb-b${n}" value="${esc(r.bimestres[n])}"></label>`).join('')}</div>
    <div class="bar" style="margin-top:10px"><button class="p" id="cb-salvar" type="button">Salvar datas dos bimestres</button> <span id="cb-msg" class="muted"></span></div></div>
    ${series.map((s) => `<div class="card"><h3 style="margin-top:0">${esc(s)}</h3><div class="tabela"><table><thead><tr><th>Caderno</th><th>Bimestre</th><th>Liberar em (opcional)</th><th>Situação</th><th></th></tr></thead><tbody>
      ${r.cadernos.filter((c) => c.serie === s).map((c) => `<tr data-id="${c.id}">
        <td><strong>${c.numero === 9 ? 'Mãos que criam' : 'Caderno ' + c.numero}</strong><br><span class="muted">${esc(c.titulo)}</span></td>
        <td><select class="cb-bim">${bims.map((n) => `<option value="${n}" ${n === c.bimestre ? 'selected' : ''}>${n}º</option>`).join('')}</select></td>
        <td><input type="date" class="cb-lib" value="${esc(c.liberar_em || '')}"><div class="muted">vale ${fmt(c.efetiva)}</div></td>
        <td><select class="cb-ativo"><option value="1" ${c.ativo ? 'selected' : ''}>Ativo</option><option value="0" ${c.ativo ? '' : 'selected'}>Oculto</option></select></td>
        <td style="white-space:nowrap"><a href="/api/admin/cadernos/arquivo/${c.id}/pdf" target="_blank" rel="noopener"><button class="s" type="button">PDF</button></a> <a href="/api/admin/cadernos/arquivo/${c.id}/html" target="_blank" rel="noopener"><button class="s" type="button">Plataforma</button></a></td></tr>`).join('')}
    </tbody></table></div></div>`).join('')}`;
  document.querySelectorAll('#cb-ac select.cb-plano').forEach((sel) => {
    sel.onchange = async () => {
      try { await api('PUT', '/api/admin/cadernos/acessos/' + sel.closest('tr').dataset.aluno, { plano: sel.value }); telaCadernos(); } catch (e) { alert(e.message); }
    };
  });
  $('cb-busca').oninput = () => { const q = $('cb-busca').value.trim().toLowerCase(); document.querySelectorAll('#cb-ac tr').forEach((tr) => { tr.style.display = !q || tr.dataset.nome.includes(q) ? '' : 'none'; }); };
  $('cb-salvar').onclick = async () => {
    const datas = {}; for (const n of bims) datas[n] = $('cb-b' + n).value;
    try { await api('PUT', '/api/admin/cadernos/bimestres', { datas }); telaCadernos(); } catch (e) { $('cb-msg').textContent = e.message; }
  };
  document.querySelectorAll('#view tr[data-id]').forEach((tr) => {
    const salvar = async () => {
      try {
        await api('PUT', '/api/admin/cadernos/' + tr.dataset.id, { bimestre: Number(tr.querySelector('.cb-bim').value), liberar_em: tr.querySelector('.cb-lib').value, ativo: tr.querySelector('.cb-ativo').value === '1' });
        telaCadernos();
      } catch (e) { alert(e.message); }
    };
    tr.querySelectorAll('select,input').forEach((el) => { el.onchange = salvar; });
  });
}
