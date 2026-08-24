import puxe from './worker-v22.js';
import {handleMesa} from './mesa.js';

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/mesa/')){
      const response=await handleMesa(request,env);
      if(response)return response;
    }
    return puxe.fetch(request,env);
  }
};
