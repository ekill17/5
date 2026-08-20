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

async function getAll(env, table, limit = 1000) {
  let offset = '';
  const records = [];
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    const data = await airtable(env, table, `?${q}`);
    records.push(...(data.records || []));
    offset = data.offset || '';
  } while (offset && records.length < limit);
  return records;
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

function cleanText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function text(card) {
  return cleanText(`${card.front || ''} ${card.body || ''} ${card.origin || ''}`);
}

function conceptMap(records) {
  return new Map(records.map(r => [r.id, cleanText(r.fields?.['Conceito'] || '')]));
}

function themeMap(records) {
  return new Map(records.map(r => [r.id, cleanText(r.fields?.['Tema'] || '')]));
}

function relationRows(records) {
  return records.map(r => ({
    origin: cleanText(r.fields?.['Origem'] || ''),
    verb: cleanText(r.fields?.['Verbo']?.name || r.fields?.['Verbo'] || ''),
    destination: cleanText(r.fields?.['Destino'] || ''),
    justification: r.fields?.['Justificativa'] || ''
  }));
}

function timelineRows(records) {
  return records.map(r => ({
    marker: cleanText(r.fields?.['Marco'] || ''),
    theme: cleanText(r.fields?.['Tema'] || ''),
    description: r.fields?.['Descrição'] || '',
    relation: r.fields?.['Relação com anterior'] || '',
    order: Number(r.fields?.['Ordem'] || 0)
  })).sort((a,b) => a.order - b.order);
}

async function getKnowledge(env) {
  const [cards, concepts, themes, relations, timeline] = await Promise.all([
    getAll(env, 'Cartões', 700),
    getAll(env, 'Conceitos', 500),
    getAll(env, 'Temas', 200),
    getAll(env, 'Relações Doutrinárias', 500),
    getAll(env, 'Linha Histórica', 200)
  ]);
  return {
    cards: cards.map(normalizeCard),
    concepts: conceptMap(concepts),
    themes: themeMap(themes),
    relations: relationRows(relations),
    timeline: timelineRows(timeline)
  };
}

function namesFor(ids, map) {
  return (ids || []).map(id => map.get(String(id))).filter(Boolean);
}

function relationEvidence(current, candidate, k) {
  const aNames = [...namesFor(current.concepts, k.concepts), ...namesFor(current.themes, k.themes)];
  const bNames = [...namesFor(candidate.concepts, k.concepts), ...namesFor(candidate.themes, k.themes)];
  let score = 0;
  let kind = '';
  let why = '';
  for (const rel of k.relations) {
    const direct = aNames.some(a => rel.origin.includes(a) || a.includes(rel.origin)) && bNames.some(b => rel.destination.includes(b) || b.includes(rel.destination));
    const reverse = aNames.some(a => rel.destination.includes(a) || a.includes(rel.destination)) && bNames.some(b => rel.origin.includes(b) || b.includes(rel.origin));
    if (!direct && !reverse) continue;
    score += 24;
    const v = rel.verb;
    if (/crit|contr|diverg|opoe|exce/.test(v)) kind = 'Contraste';
    else if (/orig|fundament|anteced|pressup/.test(v)) kind = direct ? 'Aprofundamento' : 'Origem';
    else if (/evol|desenvol|ampl|supera|sucede/.test(v)) kind = direct ? 'Evolução' : 'Origem';
    else kind = 'Aprofundamento';
    why = rel.justification || '';
    break;
  }
  return { score, kind, why };
}

function historicalEvidence(current, candidate, k) {
  const a = text(current), b = text(candidate);
  const matchedA = k.timeline.filter(t => t.marker && a.includes(t.marker) || t.theme && a.includes(t.theme));
  const matchedB = k.timeline.filter(t => t.marker && b.includes(t.marker) || t.theme && b.includes(t.theme));
  if (!matchedA.length || !matchedB.length) return { score: 0, kind: '', why: '' };
  const A = matchedA[0], B = matchedB[0];
  const delta = B.order - A.order;
  if (!delta) return { score: 5, kind: 'Aprofundamento', why: B.relation || B.description || '' };
  return {
    score: 18,
    kind: delta > 0 ? 'Evolução' : 'Origem',
    why: (delta > 0 ? B.relation : A.relation) || B.description || A.description || ''
  };
}

function scoreCandidate(current, candidate, visited, k) {
  if (!candidate || candidate.id === current.id || visited.has(candidate.id)) return { score: -999 };
  const a = text(current), b = text(candidate);
  let score = 0;

  const words = [...new Set(a.match(/[a-z]{5,}/g) || [])].slice(0, 90);
  for (const w of words) if (b.includes(w)) score += 1;

  const currentConcepts = new Set((current.concepts || []).map(String));
  for (const c of candidate.concepts || []) if (currentConcepts.has(String(c))) score += 9;

  const currentThemes = new Set((current.themes || []).map(String));
  for (const t of candidate.themes || []) if (currentThemes.has(String(t))) score += 5;

  const rel = relationEvidence(current, candidate, k);
  const hist = historicalEvidence(current, candidate, k);
  score += rel.score + hist.score;

  // Relações-piloto explicitamente sustentadas pelos cartões.
  if (/jellinek/.test(a) && /haberle|activus processualis/.test(b)) score += 35;
  if (/activus processualis|haberle/.test(a) && /amicus curiae|audiencia publica/.test(b)) score += 30;
  if (/status negativus|status positivus/.test(a) && /devido processo|remedios constitucionais/.test(b)) score += 20;

  return { score, relation: rel, historical: hist };
}

function classifyPath(current, candidate, evidence) {
  if (evidence?.relation?.kind) return evidence.relation.kind;
  if (evidence?.historical?.kind) return evidence.historical.kind;
  const a = text(current), b = text(candidate);
  if (/jellinek/.test(a) && /haberle|activus processualis/.test(b)) return 'Evolução';
  if (/activus processualis|haberle/.test(a) && /amicus curiae|audiencia publica/.test(b)) return 'Aprofundamento';
  if (/critica|contrap|dworkin|hart|waldron|sandel|nozick/.test(b)) return 'Contraste';
  if (/origem|estado liberal|histor|seculo xix|antecedente/.test(b)) return 'Origem';
  return 'Aprofundamento';
}

function bridge(current, candidate, kind, evidence) {
  if (evidence?.relation?.why) return evidence.relation.why;
  if (evidence?.historical?.why) return evidence.historical.why;
  if (kind === 'Evolução' && /jellinek/i.test(text(current)) && /activus processualis|haberle/i.test(text(candidate))) {
    return 'Jellinek descreve o status activus como a posição em que o indivíduo participa da formação da vontade estatal. Häberle amplia essa lógica para o status activus processualis: além de participar politicamente, o indivíduo passa a influenciar procedimentos decisórios do Poder Público, inclusive perante tribunais constitucionais.';
  }
  if (kind === 'Aprofundamento' && /activus processualis|haberle/i.test(text(current)) && /amicus curiae/i.test(text(candidate))) {
    return 'Häberle leva a participação para dentro do procedimento decisório e o próprio acervo aponta o amicus curiae como exemplo dessa ampliação. O próximo passo aprofunda a concretização e os limites jurídicos dessa participação.';
  }
  const a = (current.front || current.ankiId || 'o cartão atual').slice(0, 170);
  const b = (candidate.front || candidate.ankiId || 'o próximo cartão').slice(0, 170);
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
  const payload = { records: [{ fields: {
    'Fio': `Fio — ${card.ankiId || card.id}`,
    'Cartão inicial': [card.id],
    'Cartão atual': [card.id],
    'Percurso': card.ankiId || card.id,
    'Passos': 0,
    'Status': 'Em andamento',
    'Observações': 'Percurso iniciado pela interface Puxe o Fio.'
  }}] };
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
  await airtable(env, 'Fios de Estudo', '', {
    method: 'PATCH',
    body: JSON.stringify({ records: [{ id: fioId, fields }] })
  });
}

async function apiRoutes(request, env, url) {
  if (url.pathname === '/api/health') return json({ ok: true, base: env.AIRTABLE_BASE_ID });

  if (url.pathname === '/api/thread' && request.method === 'GET') {
    const currentId = url.searchParams.get('id');
    const visited = new Set((url.searchParams.get('visited') || '').split(',').filter(Boolean));
    const k = await getKnowledge(env);
    const current = k.cards.find(c => c.id === currentId || c.ankiId === currentId) || k.cards[0];
    if (!current) return json({ error: 'No cards available' }, 404);
    visited.add(current.id);

    const ranked = k.cards
      .map(card => ({ card, evidence: scoreCandidate(current, card, visited, k) }))
      .filter(x => x.evidence.score > 0)
      .sort((x, y) => y.evidence.score - x.evidence.score)
      .slice(0, 24);

    const options = [];
    const seenKinds = new Set();
    for (const item of ranked) {
      const kind = classifyPath(current, item.card, item.evidence);
      if (seenKinds.has(kind) && options.length < 3) continue;
      seenKinds.add(kind);
      options.push({
        kind,
        label: labelFor(kind),
        card: item.card,
        score: item.evidence.score,
        bridge: bridge(current, item.card, kind, item.evidence),
        basis: item.evidence.relation.score ? 'grafo doutrinário' : item.evidence.historical.score ? 'linha histórica' : 'afinidade do acervo'
      });
      if (options.length >= 4) break;
    }
    return json({ current, options });
  }

  if (url.pathname === '/api/fio/start' && request.method === 'POST') {
    const body = await request.json();
    const cards = (await getAll(env, 'Cartões', 700)).map(normalizeCard);
    const card = cards.find(c => c.id === body.cardId || c.ankiId === body.cardId);
    if (!card) return json({ error: 'Card not found' }, 404);
    return json({ fioId: await createFio(env, card) });
  }

  if (url.pathname.startsWith('/api/fio/') && request.method === 'PATCH') {
    const fioId = url.pathname.split('/').pop();
    if (!/^rec[A-Za-z0-9]{14}$/.test(fioId)) return json({ error: 'Invalid fio id' }, 400);
    await updateFio(env, fioId, await request.json());
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
