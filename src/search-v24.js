const BASE='https://api.airtable.com/v0';
const MESA_CACHE_TTL=60*1000;
let mesaCache={at:0,data:null};

const TABLES={
  issues:'Questões Eleitorais',
  theses:'Teses Eleitorais',
  precedents:'Precedentes Eleitorais',
  cards:'Cartões'
};

const CARD_SEARCH_FIELDS=[
  'ID Externo','Baralho Anki','Origem / Banca','Frente / Texto','Verso / Observações',
  'Contexto Histórico da Doutrina','Tema sugerido','Subtema sugerido','Autores sugeridos',
  'Conceitos sugeridos','Tags originais','Conceitos vinculados','Temas vinculados',
  'Conceitos Integrados','Conceitos detectados (IA)','Temas detectados (IA)',
  'Precedentes Eleitorais','Teses Eleitorais','Questões Eleitorais'
];

function clean(v=''){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim()}
function selectName(v){return typeof v==='string'?v:(v&&v.name)||''}
function uniq(a){return [...new Set((a||[]).filter(Boolean))]}
function uniqById(a){const m=new Map();for(const x of a||[])if(x?.id&&!m.has(x.id))m.set(x.id,x);return [...m.values()]}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
async function sha256(v){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function authorized(request,env){const key=request.headers.get('x-puxe-key')||'';return !!key&&(await sha256(key))===env.APP_ACCESS_HASH}
function formulaString(v){return String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}

async function airtable(env,table,params='',init={}){
  let last='';
  for(let attempt=0;attempt<5;attempt++){
    const r=await fetch(`${BASE}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${params}`,{
      ...init,
      headers:{Authorization:`Bearer ${env.AIRTABLE_TOKEN}`,'content-type':'application/json',...(init.headers||{})}
    });
    if(r.ok)return r.json();
    last=await r.text();
    if(r.status!==429&&r.status<500)throw new Error(`Airtable ${r.status}: ${last}`);
    await sleep(180*Math.pow(2,attempt)+Math.floor(Math.random()*100));
  }
  throw new Error(`Airtable temporariamente indisponível: ${last}`);
}

async function getAll(env,table,limit=500){
  let offset='',records=[];
  do{
    const q=new URLSearchParams({pageSize:'100'});
    if(offset)q.set('offset',offset);
    const d=await airtable(env,table,`?${q}`);
    records.push(...(d.records||[]));
    offset=d.offset||'';
  }while(offset&&records.length<limit);
  return records;
}

function cardSearchFormula(query){
  const escaped=formulaString(query);
  const joined=CARD_SEARCH_FIELDS.map(name=>`{${name}}`).join('&" "&');
  return `SEARCH(LOWER("${escaped}"),LOWER(${joined}))`;
}

function publicSearchCard(r){
  const f=r.fields||{};
  return {
    id:r.id,
    ankiId:f['ID Externo']||'',
    front:f['Frente / Texto']||'',
    body:f['Verso / Observações']||'',
    historicalContext:f['Contexto Histórico da Doutrina']||'',
    historicalStatus:f['Contexto Histórico da Doutrina']?'Enriquecido':'Original importado',
    annotations:[],
    concepts:uniq([f['Conceitos sugeridos']||'',f['Subtema sugerido']||'']).filter(Boolean),
    themes:uniq([f['Tema sugerido']||'',f['Subtema sugerido']||'']).filter(Boolean),
    authors:uniq([f['Autores sugeridos']||'']).filter(Boolean),
    theories:[]
  };
}

async function searchCardRows(env,query,limit=24){
  const q=String(query||'').trim();
  if(!q){
    const params=new URLSearchParams({pageSize:String(limit),maxRecords:String(limit)});
    const d=await airtable(env,TABLES.cards,`?${params}`);
    return d.records||[];
  }
  const exact=/^(ANKI-\d{4}|CHAT-[A-Za-z0-9-]+|CARD-[A-Za-z0-9-]+)$/i.test(q);
  const formula=exact?`{ID Externo}="${formulaString(q)}"`:cardSearchFormula(q);
  const params=new URLSearchParams({pageSize:String(limit),maxRecords:String(limit),filterByFormula:formula});
  const d=await airtable(env,TABLES.cards,`?${params}`);
  return d.records||[];
}

async function searchCards(request,env,url){
  if(!(await authorized(request,env)))return json({error:'Acesso não autorizado'},401);
  const q=String(url.searchParams.get('q')||'').trim().slice(0,1000);
  const rows=await searchCardRows(env,q,24);
  return json({results:rows.map(publicSearchCard),mode:'unified-card-search',searches:CARD_SEARCH_FIELDS});
}

function tokens(s){return uniq((clean(s).match(/[a-z0-9]{3,}/g)||[]).filter(x=>!['que','para','com','sem','uma','das','dos','por','quando','qual','quais','como','esta','este','eleitoral','eleicoes'].includes(x)))}
function score(query,text){const q=clean(query),hay=clean(text);if(!q)return 1;let s=hay.includes(q)?55:0;const ts=tokens(q);for(const t of ts)if(hay.includes(t))s+=8;if(ts.length){const hit=ts.filter(t=>hay.includes(t)).length;s+=Math.round(25*hit/ts.length)}return s}
function issueText(f){return [f['Questão'],f['Tema eleitoral'],f['Subquestões'],f['Critérios relevantes'],f['Fundamento normativo esperado'],f['Pegadinhas / distinções'],f['Palavras-chave']].join(' ')}
function thesisText(f){return [f['Tese'],f['Tema eleitoral'],f['Formulação consolidada'],f['Fundamento normativo'],f['Exceções / ressalvas'],f['Contraprova / riscos'],f['Palavras-chave']].join(' ')}
function precedentText(f){return [f['Precedente'],f['Tribunal'],f['Órgão julgador'],f['Processo'],f['Relator'],f['Tema eleitoral'],f['Tese extraída'],f['Circunstâncias determinantes'],f['Consequência prática'],f['Distinções / ressalvas'],f['Identificador oficial'],f['Palavras-chave']].map(selectName).join(' ')}

function publicIssue(r){const f=r.fields||{};return{id:r.id,question:f['Questão']||'',theme:f['Tema eleitoral']||'',subquestions:f['Subquestões']||'',criteria:f['Critérios relevantes']||'',foundation:f['Fundamento normativo esperado']||'',distinctions:f['Pegadinhas / distinções']||'',status:selectName(f['Status'])||'',thesisIds:f['Teses']||[],precedentIds:f['Precedentes']||[],cardIds:f['Cartões relacionados']||[],keywords:f['Palavras-chave']||''}}
function publicThesis(r){const f=r.fields||{};return{id:r.id,title:f['Tese']||'',theme:f['Tema eleitoral']||'',statement:f['Formulação consolidada']||'',foundation:f['Fundamento normativo']||'',exceptions:f['Exceções / ressalvas']||'',counter:f['Contraprova / riscos']||'',state:selectName(f['Estado'])||'',confidence:selectName(f['Confiança'])||'',precedentIds:f['Precedentes']||[],cardIds:f['Cartões relacionados']||[],keywords:f['Palavras-chave']||''}}
function publicPrecedent(r){const f=r.fields||{};return{id:r.id,title:f['Precedente']||'',court:selectName(f['Tribunal'])||'',chamber:f['Órgão julgador']||'',process:f['Processo']||'',relator:f['Relator']||'',date:f['Data do julgamento']||'',theme:f['Tema eleitoral']||'',holding:f['Tese extraída']||'',facts:f['Circunstâncias determinantes']||'',effect:f['Consequência prática']||'',distinctions:f['Distinções / ressalvas']||'',value:selectName(f['Valor do precedente'])||'',state:selectName(f['Situação'])||'',source:f['Fonte oficial']||'',officialId:f['Identificador oficial']||'',cardIds:f['Cartões relacionados']||[],keywords:f['Palavras-chave']||''}}
function publicMesaCard(r){const f=r.fields||{};return{id:r.id,ankiId:f['ID Externo']||'',title:(f['Frente / Texto']||f['Verso / Observações']||'Cartão').replace(/\s+/g,' ').slice(0,180),theme:f['Tema sugerido']||'',issueIds:f['Questões Eleitorais']||[],thesisIds:f['Teses Eleitorais']||[],precedentIds:f['Precedentes Eleitorais']||[]}}

async function loadMesa(env){
  if(mesaCache.data&&Date.now()-mesaCache.at<MESA_CACHE_TTL)return mesaCache.data;
  const [issuesR,thesesR,precedentsR]=await Promise.all([
    getAll(env,TABLES.issues,300),getAll(env,TABLES.theses,300),getAll(env,TABLES.precedents,500)
  ]);
  const data={issuesR,thesesR,precedentsR,issues:issuesR.map(publicIssue),theses:thesesR.map(publicThesis),precedents:precedentsR.map(publicPrecedent),loadedAt:new Date().toISOString()};
  mesaCache={at:Date.now(),data};
  return data;
}

function rankRecords(query,records,rawRecords,textFn,boostIds=new Set()){
  return records.map((x,i)=>({x,s:score(query,textFn(rawRecords[i]?.fields||{}))+(boostIds.has(x.id)?45:0)})).filter(v=>!query||v.s>0).sort((a,b)=>b.s-a.s);
}

async function cardsByIds(env,ids){
  const list=uniq(ids);
  if(!list.length)return[];
  const out=[];
  for(let i=0;i<list.length;i+=20){
    const chunk=list.slice(i,i+20);
    const formula=`OR(${chunk.map(id=>`RECORD_ID()="${formulaString(id)}"`).join(',')})`;
    const p=new URLSearchParams({pageSize:'100',filterByFormula:formula});
    const d=await airtable(env,TABLES.cards,`?${p}`);
    out.push(...(d.records||[]).map(publicMesaCard));
  }
  return out;
}

function modeName(mode){return mode==='dossier'?'Dossiê':mode==='case'?'Tenho este caso':mode==='foundation'?'Construir fundamentação':mode==='counter'?'Contraprova':'Consulta rápida'}

async function queryMesa(request,env,url){
  if(!(await authorized(request,env)))return json({error:'Acesso não autorizado'},401);
  const q=String(url.searchParams.get('q')||'').trim().slice(0,6000);
  const mode=String(url.searchParams.get('mode')||'quick');
  if(!q)return json({error:'Descreva uma questão ou problema eleitoral.'},400);

  const [k,matchedCardRows]=await Promise.all([loadMesa(env),searchCardRows(env,q,16)]);
  const matchedCards=matchedCardRows.map(publicMesaCard);
  const cardIssueIds=new Set(matchedCards.flatMap(x=>x.issueIds));
  const cardThesisIds=new Set(matchedCards.flatMap(x=>x.thesisIds));
  const cardPrecedentIds=new Set(matchedCards.flatMap(x=>x.precedentIds));

  const issueRank=rankRecords(q,k.issues,k.issuesR,issueText,cardIssueIds);
  let issues=issueRank.slice(0,mode==='case'?6:4).map(v=>v.x);
  for(const id of cardIssueIds){const x=k.issues.find(v=>v.id===id);if(x&&!issues.some(v=>v.id===id))issues.push(x)}
  issues=issues.slice(0,8);

  const linkedTheses=new Set([...cardThesisIds,...issues.flatMap(x=>x.thesisIds)]);
  const linkedPrecedents=new Set([...cardPrecedentIds,...issues.flatMap(x=>x.precedentIds)]);
  const thesisRank=rankRecords(q,k.theses,k.thesesR,thesisText,linkedTheses);
  let theses=thesisRank.slice(0,mode==='foundation'?6:5).map(v=>v.x);
  for(const id of linkedTheses){const t=k.theses.find(x=>x.id===id);if(t&&!theses.some(x=>x.id===id))theses.push(t)}
  theses=theses.slice(0,8);

  const thesisPrecedents=new Set(theses.flatMap(x=>x.precedentIds));
  const pBoost=new Set([...linkedPrecedents,...thesisPrecedents]);
  const precedentRank=rankRecords(q,k.precedents,k.precedentsR,precedentText,pBoost);
  let precedents=precedentRank.slice(0,mode==='foundation'?9:7).map(v=>v.x);
  for(const id of pBoost){const p=k.precedents.find(x=>x.id===id);if(p&&!precedents.some(x=>x.id===id))precedents.push(p)}
  precedents=precedents.slice(0,10);

  if(mode==='dossier'){
    const theme=issues[0]?.theme||theses[0]?.theme||precedents[0]?.theme||matchedCards[0]?.theme||'';
    if(theme){
      const ct=clean(theme);
      issues=uniqById([...issues,...k.issues.filter(x=>clean(x.theme)===ct)]).slice(0,8);
      theses=uniqById([...theses,...k.theses.filter(x=>clean(x.theme)===ct)]).slice(0,10);
      precedents=uniqById([...precedents,...k.precedents.filter(x=>clean(x.theme)===ct)]).slice(0,14);
    }
  }

  const relatedCardIds=uniq([...issues.flatMap(x=>x.cardIds),...theses.flatMap(x=>x.cardIds),...precedents.flatMap(x=>x.cardIds)]);
  const linkedCards=await cardsByIds(env,relatedCardIds);
  const cards=uniqById([...matchedCards,...linkedCards]).slice(0,18);
  const timeline=precedents.filter(x=>x.date).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))).map(x=>({id:x.id,date:x.date,title:x.title,process:x.process,court:x.court,state:x.state}));
  const foundation=uniq([...theses.map(x=>x.foundation),...issues.map(x=>x.foundation)]).filter(Boolean);
  const counterpoints=uniq([...theses.map(x=>x.counter),...theses.map(x=>x.exceptions),...precedents.map(x=>x.distinctions)]).filter(Boolean);
  const summary=theses[0]?.statement||precedents[0]?.holding||(cards.length?'Foram encontrados cartões relacionados no acervo, mas ainda não há tese consolidada suficiente para esta consulta.':'Ainda não há tese consolidada suficiente no acervo para esta consulta.');

  return json({query:q,mode,modeLabel:modeName(mode),summary,issues,theses,precedents,cards,timeline,foundation,counterpoints,loadedAt:k.loadedAt,searchMode:'transversal-card-structured',warning:'A Mesa pesquisa conteúdo dos cartões e conhecimento estruturado salvo. Confira a fonte oficial antes de citar e use apenas descrição pública ou anonimizada de casos.'});
}

export async function handleUnifiedSearch(request,env){
  const url=new URL(request.url);
  try{
    if(url.pathname==='/api/cards/search'&&request.method==='GET')return await searchCards(request,env,url);
    if(url.pathname==='/api/mesa/query'&&request.method==='GET')return await queryMesa(request,env,url);
    if(url.pathname==='/api/search/health'&&request.method==='GET')return json({ok:true,version:'2.4',cardFields:CARD_SEARCH_FIELDS,mesaCacheTtlSeconds:MESA_CACHE_TTL/1000});
    return null;
  }catch(e){
    console.error('Unified search v2.4',e);
    return json({error:e.message||'Falha na pesquisa transversal'},500);
  }
}
