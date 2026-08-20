const BASE = 'https://api.airtable.com/v0';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function airtable(env, table, params = '', init = {}) {
  if (!env.AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN secret is not configured');
  const url = `${BASE}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${params}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

function normalizeCard(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    ankiId: f['ID Externo'] || '',
    front: f['Frente / Texto'] || '',
    body: f['Verso / Observações'] || '',
    origin: f['Origem / Banca'] || '',
    concepts: Array.isArray(f['Conceitos vinculados']) && f['Conceitos vinculados'].length
      ? f['Conceitos vinculados']
      : (Array.isArray(f['Conceitos detectados (IA)']) ? f['Conceitos detectados (IA)'] : []),
    themes: Array.isArray(f['Temas vinculados']) && f['Temas vinculados'].length
      ? f['Temas vinculados']
      : (Array.isArray(f['Temas detectados (IA)']) ? f['Temas detectados (IA)'] : []),
    raw: f
  };
}

async function getCards(env) {
  let offset = '';
  const records = [];
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    const data = await airtable(env, 'Cartões', `?${q}`);
    records.push(...(data.records || []));
    offset = data.offset || '';
  } while (offset && records.length < 700);
  return records.map(normalizeCard);
}

function cleanText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function text(card) {
  return cleanText(`${card.front || ''} ${card.body || ''} ${card.origin || ''}`);
}

function scoreCandidate(current, candidate, visited) {
  if (!candidate || candidate.id === current.id || visited.has(candidate.id)) return -999;
  const a = text(current), b = text(candidate);
  let score = 0;
  const words = [...new Set(a.match(/[a-z]{5,}/g) || [])].slice(0, 90);
  for (const w of words) if (b.includes(w)) score += 1;

  const currentConcepts = new Set((current.concepts || []).map(String));
  for (const c of candidate.concepts || []) if (currentConcepts.has(String(c))) score += 8;

  const currentThemes = new Set((current.themes || []).map(String));
  for (const t of candidate.themes || []) if (currentThemes.has(String(t))) score += 4;

  // Regras de continuidade confirmadas no acervo-piloto.
  if (/jellinek/.test(a) && /haberle|activus processualis/.test(b)) score += 35;
  if (/activus processualis|haberle/.test(a) && /amicus curiae|audiencia publica/.test(b)) score += 30;
  if (/status negativus|status positivus/.test(a) && /devido processo|remedios constitucionais/.test(b)) score += 20;
  return score;
}

function classifyPath(current, candidate) {
  const a = text(current), b = text(candidate);
  if (/jellinek/.test(a) && /haberle|activus processualis/.test(b)) return 'Evolução';
  if (/activus processualis|haberle/.test(a) && /amicus curiae|audiencia publica/.test(b)) return 'Aprofundamento';
  if (/critica|contrap|dworkin|hart|waldron|sandel|nozick/.test(b)) return 'Contraste';
  if (/origem|estado liberal|histor|seculo xix|antecedente/.test(b)) return 'Origem';
  return 'Aprofundamento';
}

function bridge(current, candidate, kind) {
  const a = (current.front || current.ankiId || 'o cartão atual').slice(0, 170);
  const b = (candidate.front || candidate.ankiId || 'o próximo cartão').slice(0, 170);
  if (kind === 'Evolução' && /jellinek/i.test(text(current)) && /activus processualis|haberle/i.test(text(candidate))) {
    return 'Jellinek descreve o status activus como a posição em que o indivíduo participa da formação da vontade estatal. Häberle amplia essa lógica para o status activus processualis: além de participar politicamente, o indivíduo passa a influenciar procedimentos decisórios do Poder Público, inclusive perante tribunais constitucionais.';
  }
  if (kind === 'Aprofundamento' && /activus processualis|haberle/i.test(text(current)) && /amicus curiae/i.test(text(candidate))) {
    return 'Häberle leva a participação para dentro do procedimento decisório e o próprio acervo aponta o amicus curiae como exemplo dessa ampliação. O próximo passo aprofunda a concretização e os limites jurídicos dessa participação.';
  }
  const generic = {
    'Evolução': `O próximo passo mostra uma evolução da ideia estudada: partimos de ${a} para ${b}, preservando a continuidade intelectual do tema.`,
    'Aprofundamento': `O fio sai da formulação geral de ${a} e entra em um desdobramento mais específico, representado por ${b}.`,
    'Origem': `Este caminho recua para o contexto intelectual que ajuda a explicar por que a construção vista em ${a} surgiu e qual problema procurava resolver.`,
    'Contraste': `Este caminho mantém o mesmo problema jurídico, mas troca a lente teórica, permitindo comparar ${a} com uma resposta doutrinária diferente.`
  };
  return generic[kind] || generic['Aprofundamento'];
}

function labelFor(kind) {
  return kind === 'Origem' ? 'Quero entender de onde isso veio'
    : kind === 'Evolução' ? 'Quero avançar historicamente'
    : kind === 'Contraste' ? 'Quero ver outra forma de pensar o problema'
    : 'Quero aprofundar a teoria';
}

async function createFio(env, card) {
  const payload = {
    records: [{ fields: {
      'Fio': `Fio — ${card.ankiId || card.id}`,
      'Cartão inicial': [card.id],
      'Cartão atual': [card.id],
      'Percurso': card.ankiId || card.id,
      'Passos': 0,
      'Status': 'Em andamento',
      'Observações': 'Percurso iniciado pela interface Puxe o Fio.'
    }}]
  };
  const data = await airtable(env, 'Fios de Estudo', '', { method: 'POST', body: JSON.stringify(payload) });
  return data.records?.[0]?.id || null;
}

async function updateFio(env, fioId, body) {
  const fields = {
    'Cartão atual': [body.currentCardId],
    'Percurso': body.path || '',
    'Último caminho escolhido': body.kind || 'Aprofundamento',
    'Última transição contextual': body.bridge || '',
    'Passos': Number(body.steps || 0),
    'Status': body.status || 'Em andamento'
  };
  const payload = { records: [{ id: fioId, fields }] };
  await airtable(env, 'Fios de Estudo', '', { method: 'PATCH', body: JSON.stringify(payload) });
  return true;
}

async function apiRoutes(request, env, url) {
  if (url.pathname === '/api/health') return json({ ok: true, base: env.AIRTABLE_BASE_ID });

  if (url.pathname === '/api/thread' && request.method === 'GET') {
    const currentId = url.searchParams.get('id');
    const visited = new Set((url.searchParams.get('visited') || '').split(',').filter(Boolean));
    const cards = await getCards(env);
    const current = cards.find(c => c.id === currentId || c.ankiId === currentId) || cards[0];
    if (!current) return json({ error: 'No cards available' }, 404);
    visited.add(current.id);

    const ranked = cards
      .map(c => ({ card: c, score: scoreCandidate(current, c, visited) }))
      .filter(x => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 20);

    const options = [];
    const seenKinds = new Set();
    for (const item of ranked) {
      const kind = classifyPath(current, item.card);
      if (seenKinds.has(kind) && options.length < 3) continue;
      seenKinds.add(kind);
      options.push({
        kind,
        label: labelFor(kind),
        card: item.card,
        score: item.score,
        bridge: bridge(current, item.card, kind)
      });
      if (options.length >= 4) break;
    }
    return json({ current, options });
  }

  if (url.pathname === '/api/fio/start' && request.method === 'POST') {
    const body = await request.json();
    const cards = await getCards(env);
    const card = cards.find(c => c.id === body.cardId || c.ankiId === body.cardId);
    if (!card) return json({ error: 'Card not found' }, 404);
    const fioId = await createFio(env, card);
    return json({ fioId });
  }

  if (url.pathname.startsWith('/api/fio/') && request.method === 'PATCH') {
    const fioId = url.pathname.split('/').pop();
    if (!/^rec[A-Za-z0-9]{14}$/.test(fioId)) return json({ error: 'Invalid fio id' }, 400);
    const body = await request.json();
    await updateFio(env, fioId, body);
    return json({ ok: true });
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        const r = await apiRoutes(request, env, url);
        if (r) return r;
        return json({ error: 'API route not found' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
