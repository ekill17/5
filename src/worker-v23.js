import puxe from './worker-v22.js';
import {handleMesa} from './mesa.js';

async function withMesaEntry(response,url){
  if(url.pathname!=='/'&&url.pathname!=='/index.html')return response;
  const type=response.headers.get('content-type')||'';
  if(!type.includes('text/html'))return response;
  let html=await response.text();
  if(!html.includes('mesa-entry.js'))html=html.replace('</body>','<script src="/mesa-entry.js"></script></body>');
  const headers=new Headers(response.headers);headers.delete('content-length');headers.set('cache-control','no-cache');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/mesa/')){
      const response=await handleMesa(request,env);
      if(response)return response;
    }
    const response=await puxe.fetch(request,env);
    return withMesaEntry(response,url);
  }
};
