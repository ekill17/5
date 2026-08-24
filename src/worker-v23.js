import puxe from './worker-v22.js';
import {handleMesa} from './mesa.js';
import {handleMesaHistory} from './mesa-history.js';

async function enrichHtml(response,url){
  const type=response.headers.get('content-type')||'';
  if(!type.includes('text/html'))return response;
  let html=await response.text();
  if((url.pathname==='/'||url.pathname==='/index.html')&&!html.includes('mesa-entry.js'))html=html.replace('</body>','<script src="/mesa-entry.js"></script></body>');
  if(url.pathname==='/mesa.html'&&!html.includes('mesa-history-ui.js'))html=html.replace('</body>','<script src="/mesa-history-ui.js"></script></body>');
  const headers=new Headers(response.headers);headers.delete('content-length');headers.set('cache-control','no-cache');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    const historyResponse=await handleMesaHistory(request,env);
    if(historyResponse)return historyResponse;
    if(url.pathname.startsWith('/api/mesa/')){
      const response=await handleMesa(request,env);
      if(response)return response;
    }
    const response=await puxe.fetch(request,env);
    return enrichHtml(response,url);
  }
};
