// 零依赖静态服务器：只服务本目录，127.0.0.1:5197。
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {dirname,extname,join,normalize,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown; charset=utf-8'};
createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{allow:'GET, HEAD'});return res.end();}
    let pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname.includes('\0')) throw Object.assign(new Error('bad path'),{status:400});
    if(pathname.endsWith('/')) pathname+='index.html';
    const file=normalize(join(root,pathname));
    if(file!==root&&!file.startsWith(root+sep)) throw Object.assign(new Error('forbidden'),{status:403});
    if(!(await stat(file)).isFile()) throw Object.assign(new Error('not found'),{status:404});
    res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch(error){const status=error.status||(error.code==='ENOENT'?404:500);res.writeHead(status,{'content-type':'text/plain; charset=utf-8'});res.end(status===404?'Not found':status===403?'Forbidden':status===400?'Bad request':'Server error');}
}).listen(5197,'127.0.0.1',()=>console.log('M1 demo: http://127.0.0.1:5197/'));
