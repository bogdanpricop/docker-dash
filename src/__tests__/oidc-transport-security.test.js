'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'oidc-transport-fixture',ENCRYPTION_KEY:'oidc-transport-fixture-key-32chr'});
const https=require('https'),{EventEmitter}=require('events');
const cache=require('../routes/auth')._oidcCacheInternals;
const transport=require('../utils/oidc-http');
const issuer='https://provider.example.test';
let requests,spy;
beforeEach(()=>{
  cache.clear();cache.resetFetcher();requests=[];
  spy=jest.spyOn(https,'request').mockImplementation((options,callback)=>{
    const req=new EventEmitter();req.write=jest.fn();req.end=jest.fn();req.destroy=jest.fn();
    requests.push({req,options,callback});return req;
  });
});
afterEach(()=>{spy.mockRestore();jest.useRealTimers();cache.clear();cache.resetFetcher();});
function respond(body,headers={}) {
 const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json',...headers};res.complete=true;res.destroy=jest.fn();
 requests.at(-1).callback(res);res.emit('data',Buffer.from(body));res.emit('end');return res;
}
test('oversized discovery body is rejected before caching',async()=>{
 const pending=cache.getDiscovery(issuer);await Promise.resolve();
 respond(JSON.stringify({issuer,padding:'x'.repeat(1024*1024)}));
 await expect(pending).rejects.toThrow();expect(requests[0].req.destroy).toHaveBeenCalled();
});
test('absolute deadline includes waiting for a response without an idle timeout event',async()=>{
 jest.useFakeTimers();const pending=cache.getDiscovery(issuer);const result=expect(pending).rejects.toThrow(/timeout|deadline/i);
 await jest.advanceTimersByTimeAsync(10001);expect(requests[0].req.destroy).toHaveBeenCalled();await result;
});
test('failed discovery HTTP status is not cached as configuration',async()=>{
 cache.setFetcher(async()=>({status:503,body:{issuer,authorization_endpoint:issuer+'/authorize'}}));
 await expect(cache.getDiscovery(issuer)).rejects.toThrow();
});
test.each(['http://example.test','https://user:password@example.test','https://example.test/#secret','https://example.test/\nunsafe',null])('invalid endpoint %j is rejected before opening a socket',async value=>{
 await expect(transport.fetchJson(value)).rejects.toThrow('Invalid OIDC endpoint');expect(requests).toHaveLength(0);
});
test.each(['{}','{"name":"Bucuresti"}'])('valid object %s is parsed with a bounded verified transport',async body=>{
 const pending=transport.fetchJson(issuer);respond(body);await expect(pending).resolves.toEqual({status:200,body:JSON.parse(body)});
 expect(requests[0].options).toMatchObject({rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384});
});
test.each(['invalid','null','[]','42'])('invalid JSON object %s is rejected',async body=>{
 const pending=transport.fetchJson(issuer);respond(body);await expect(pending).rejects.toThrow('JSON object');
});
test.each([{'content-length':String(transport.MAX_BYTES+1)},{'content-type':'text/html'},{'content-encoding':'gzip'}])('invalid response headers %j are rejected',async headers=>{
 const pending=transport.fetchJson(issuer);const res=respond('{}',headers);await expect(pending).rejects.toThrow();expect(res.destroy).toHaveBeenCalled();
});
test('split UTF-8 characters are decoded only after bytes are assembled',async()=>{
 const pending=transport.fetchJson(issuer),res=new EventEmitter();Object.assign(res,{headers:{'content-type':'application/json'},statusCode:200,complete:true,destroy:jest.fn()});
 requests[0].callback(res);const body=Buffer.from('{"name":"é"}');const split=body.indexOf(0xc3)+1;
 res.emit('data',body.subarray(0,split));res.emit('data',body.subarray(split));res.emit('end');
 await expect(pending).resolves.toEqual({status:200,body:{name:'é'}});
});
test('concurrency is bounded without a pending queue and slots recover',async()=>{
 const pending=Array.from({length:transport.MAX_IN_FLIGHT},()=>transport.fetchJson(issuer));
 await expect(transport.fetchJson(issuer)).rejects.toThrow('busy');expect(requests).toHaveLength(8);
 const outcomes=Promise.allSettled(pending);for(const item of requests)item.req.emit('error',new Error('secret must not escape'));
 expect((await outcomes).every(item=>item.status==='rejected'&&item.reason.message==='OIDC request failed')).toBe(true);
 const recovered=transport.fetchJson(issuer);respond('{}');await expect(recovered).resolves.toBeTruthy();
});
test.each(['aborted','error','close'])('interrupted response %s rejects without waiting for the deadline',async event=>{
 const pending=transport.fetchJson(issuer),res=new EventEmitter();Object.assign(res,{headers:{'content-type':'application/json'},statusCode:200,complete:false,destroy:jest.fn()});
 requests[0].callback(res);res.emit(event);await expect(pending).rejects.toThrow();expect(requests[0].req.destroy).toHaveBeenCalled();
});
const discovery={issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys'};
test.each([{issuer:'https://another.example.test'},{token_endpoint:'http://example.test/token'},{jwks_uri:'https://secret@example.test/keys'},{userinfo_endpoint:'https://example.test/#fragment'}])('invalid discovery %j never enters the cache',async fields=>{
 let count=0;cache.setFetcher(async()=>{count++;return {status:200,body:{...discovery,...fields}};});
 await expect(cache.getDiscovery(issuer)).rejects.toThrow();await expect(cache.getDiscovery(issuer)).rejects.toThrow();expect(count).toBe(2);
});
test('concurrent discovery and JWKS misses share one upstream request each',async()=>{
 const fetcher=jest.fn(async url=>({status:200,body:url.endsWith('/keys')?{keys:[{kty:'RSA',kid:'test'}]}:discovery}));cache.setFetcher(fetcher);
 const result=await Promise.all(Array.from({length:25},()=>cache.getJwks(issuer)));
 expect(fetcher).toHaveBeenCalledTimes(2);expect(result.every(value=>value===result[0])).toBe(true);
});
test.each([{status:500,body:{keys:[{}]}},{status:200,body:{keys:{}}},{status:200,body:{keys:[null]}},{status:200,body:{keys:Array.from({length:101},()=>({}))}}])('malformed JWKS response is refused %#',async response=>{
 cache.setFetcher(async url=>url.endsWith('/keys')?response:{status:200,body:discovery});await expect(cache.getJwks(issuer)).rejects.toThrow('Invalid JWKS');
});
