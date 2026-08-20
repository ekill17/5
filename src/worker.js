const BASE = 'https://api.airtable.com/v0';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function airtable(env, table, params = '') {
  if (!env.AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN secret is not configured');
  const url = `${BASE}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${params}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

function normalizeCard(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    ankiId: f['ID Anki'] || f['ID'] || f['Código'] || Object.values(f).find(v => typeof v === 'string' && /^ANKI-\d{4}$/.test(v)) || '',
    front: f['Frente'] || f['Pergunta'] || f['Título'] || '',
    body: f['Texto'] || f['Conteúdo'] || f['Verso'] || f['Resposta'] || '',
    concepts: Array.isArray(f['Conceito detectado (IA)']) ? f['Conceito detectado (IA)'] : (Array.isArray(f['Conceitos']) ? f['Conceitos'] : []),
    theme: Array.isArray(f['Tema']) ? f['Tema'] : [],
    raw: f
  };
}

async function getCards(env, formula = '') {
  let offset = '';
  const records = [];
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    if (formula) q.set('filterByFormula', formula);
    const data = await airtable(env, 'Cartões', `?${q}`);
    records.push(...(data.records || []));
    offset = data.offset || '';
  } while (offset && records.length < 700);
  return records.map(normalizeCard);
}

function text(card) {
  return `${card.front || ''} ${card.body || ''}`.toLowerCase();
}

function scoreCandidate(current, candidate, visited) {
  if (!candidate || candidate.id === current.id || visited.has(candidate.id)) return -999;
  const a = text(current), b = text(candidate);
  let score = 0;
  const words = [...new Set(a.normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-zà-ÿ]{5,}/g) || [])].slice(0,80);
  for (const w of words) if (b.includes(w)) score += 1;
  const currentConcepts = new Set((current.concepts || []).map(String));
  for (const c of candidate.concepts || []) if (currentConcepts.has(String(c))) score += 7;
  if (/jellinek/.test(a) && /häberle|haberle|activus processualis/.test(b)) score += 30;
  if (/activus processualis|häberle|haberle/.test(a) && /amicus curiae|audiência pública|audiencia publica/.test(b)) score += 25;
  if (/status negativus|status positivus/.test(a) && /devido processo|remédios constitucionais|remedios constitucionais/.test(b)) score += 18;
  return score;
}

function classifyPath(current, candidate) {
  const a = text(current), b = text(candidate);
  if (/jellinek/.test(a) && /häberle|haberle|activus processualis/.test(b)) return 'Evolução';
  if (/activus processualis/.test(a) && /amicus curiae|audiência pública|audiencia publica/.test(b)) return 'Aprofundamento';
  if (/crítica|critica|contrapõe|contrapo[eõ]|dworkin|hart/.test(b)) return 'Contraste';
  if (/século|origem|estado liberal|antecedente/.test(b)) return 'Origem';
  return 'Aprofundamento';
}

function bridge(current, candidate, kind) {
  const titleA = current.front || current.ankiId || 'este cartão';
  const titleB = candidate.front || candidate.ankiId || 'o próximo cartão';
  const canned = {
    'Evolução': `O próximo passo mostra uma evolução da ideia estudada: partimos de ${titleA} para uma formulação posterior que amplia ou transforma o problema sem romper sua continuidade intelectual.`,
    'Aprofundamento': `Agora o fio sai da formulação geral de ${titleA} e entra em uma consequência, aplicação ou desdobramento mais específico, representado por ${titleB}.`,
    'Origem': `Este caminho recua para o contexto intelectual que ajuda a explicar por que a construção vista em ${titleA} surgiu e qual problema procurava resolver.`,
    'Contraste': `Este caminho mantém o mesmo problema jurídico, mas troca a lente teórica, permitindo comparar ${titleA} com uma resposta doutrinária diferente.`
  };
  return canned[kind] || canned['Aprofundamento'];
}

async function apiRoutes(request, env, url) {
  if (url.pathname === '/api/health') return json({ ok: true, base: env.AIRTABLE_BASE_ID });

  if (url.pathname === '/api/card') {
    const id = url.searchParams.get('id');
    const anki = url.searchParams.get('anki');
    const cards = await getCards(env);
    const card = cards.find(c => c.id === id || c.ankiId === anki) || cards[0];
    return card ? json(card) : json({ error: 'Card not found' }, 404);
  }

  if (url.pathname === '/api/thread') {
    const currentId = url.searchParams.get('id');
    const visited = new Set((url.searchParams.get('visited') || '').split(',').filter(Boolean));
    const cards = await getCards(env);
    const current = cards.find(c => c.id === currentId || c.ankiId === currentId) || cards[0];
    if (!current) return json({ error: 'No cards available' }, 404);
    visited.add(current.id);
    const candidates = cards
      .map(c => ({ card: c, score: scoreCandidate(current, c, visited) }))
      .filter(x => x.score > 0)
      .sort((x,y) => y.score - x.score)
      .slice(0, 12);

    const seenKinds = new Set();
    const options = [];
    for (const {card, score} of candidates) {
      const kind = classifyPath(current, card);
      if (seenKinds.has(kind) && options.length < 3) continue;
      seenKinds.add(kind);
      options.push({
        kind,
        label: kind === 'Origem' ? 'Quero entender de onde isso veio' : kind === 'Evolução' ? 'Quero avançar historicamente' : kind === 'Contraste' ? 'Quero ver outra forma de pensar o problema' : 'Quero aprofundar a teoria',
        card,
        score,
        bridge: bridge(current, card, kind)
      });
      if (options.length >= 4) break;
    }
    return json({ current, options });
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
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
