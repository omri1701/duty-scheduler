import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {requireDevelopmentPort} from '../scripts/development-port.mjs';

test('target switching rejects an occupied port before checking another running application',async()=>{
 const server=createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 try {await assert.rejects(requireDevelopmentPort(port),/already in use.*Stop the existing/);}
 finally {await new Promise(resolve=>server.close(resolve));}
 await requireDevelopmentPort(port);
});
