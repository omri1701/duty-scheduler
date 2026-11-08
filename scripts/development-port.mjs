import {createServer} from 'node:net';

export async function requireDevelopmentPort(port = 5173) {
  await new Promise((resolve,reject)=>{
    const server=createServer();
    server.once('error',error=>reject(error.code==='EADDRINUSE'
      ? Error(`Port ${port} is already in use. Stop the existing development server before starting or switching DEV/LOCAL targets.`)
      : error));
    server.listen(port,'127.0.0.1',()=>server.close(resolve));
  });
}
