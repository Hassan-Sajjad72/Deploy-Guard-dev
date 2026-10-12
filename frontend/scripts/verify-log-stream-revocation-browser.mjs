import {strict as assert} from "node:assert";
import {createServer as createHttpServer} from "node:http";
import {chromium,expect} from "@playwright/test";
import {createServer as createViteServer} from "vite";

const projectId="11111111-1111-4111-8111-111111111111",serviceA="22222222-2222-4222-8222-222222222222",serviceB="33333333-3333-4333-8333-333333333333";
const connections=[],unexpectedRequests=[];
const frame=(name,payload)=>`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
const line=(id,message)=>({id,message,source:"app",timestamp:new Date().toISOString()});
const state={stateAuthority:{state:"LIVE",runtime:{state:"present",source:"aws_observation"},infrastructure:{exists:true},applicationHealth:{status:"healthy"},monitoring:{available:true}},infrastructureEvidence:{runtimeIdentity:{services:[{serviceId:serviceA,serviceName:"Application A",ecs:{service:"owned-a"}},{serviceId:serviceB,serviceName:"Application B",ecs:{service:"owned-b"}}]}}};
const fixture=createHttpServer((request,response)=>{
  response.setHeader("Access-Control-Allow-Origin",request.headers.origin||"http://127.0.0.1");response.setHeader("Access-Control-Allow-Credentials","true");response.setHeader("Access-Control-Allow-Headers","Content-Type, X-DeployGuard-Route");response.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");response.setHeader("Vary","Origin");
  if(request.method==="OPTIONS"){response.writeHead(204);response.end();return;}
  const url=new URL(request.url,"http://127.0.0.1"),path=url.pathname;
  if(path===`/api/projects/${projectId}/observability/application-logs/stream`){
    const serviceId=url.searchParams.get("serviceId");assert.ok([serviceA,serviceB].includes(serviceId));
    response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});response.flushHeaders();
    const connection={serviceId,response,closed:false};connections.push(connection);response.on("close",()=>{connection.closed=true;});
    response.write("retry: 50\n\n");response.write(frame("connected",{generationId:"fixture-generation",history:[line(`history-${serviceId}`,`retained history for ${serviceId}`)]}));return;
  }
  let body;
  if(path==="/api/auth/me")body={user:{id:1,role:"developer",githubLogin:"fixture-owner"}};
  else if(path===`/api/projects/${projectId}`)body={project:{id:projectId,name:"Local SSE fixture"}};
  else if(path===`/api/projects/${projectId}/current-state/details`)body=state;
  else if(path===`/api/projects/${projectId}/observability/application-metrics`)body={availabilityState:"available",cpu:{points:[{timestamp:new Date().toISOString(),value:25}]},grafana:{configured:false}};
  else if(path===`/api/projects/${projectId}/activity/view`)body={};
  else {unexpectedRequests.push(path);response.writeHead(404,{"Content-Type":"application/json"});response.end(JSON.stringify({message:"Unknown local fixture route"}));return;}
  response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(body));
});
const listen=server=>new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
const latest=serviceId=>connections.filter(connection=>connection.serviceId===serviceId&&!connection.closed).at(-1);
const count=serviceId=>connections.filter(connection=>connection.serviceId===serviceId).length;
let vite,browser;
try{
  await listen(fixture);const apiOrigin=`http://127.0.0.1:${fixture.address().port}`;
  vite=await createViteServer({define:{"import.meta.env.VITE_API_BASE_URL":JSON.stringify(apiOrigin)},server:{host:"127.0.0.1",port:0},logLevel:"error"});await vite.listen();
  browser=await chromium.launch({executablePath:process.env.DG_CHROME_BIN||"/usr/bin/google-chrome",args:["--no-sandbox"],headless:true});const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
  // Capture actual native EventSource instances so late queued callbacks can be delivered after closure; their transport is never mocked.
  await page.addInitScript(()=>{const NativeEventSource=window.EventSource;window.__fixtureEventSources=[];window.EventSource=class extends NativeEventSource{constructor(...args){super(...args);window.__fixtureEventSources.push(this);}};});
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/projects/${projectId}/monitoring`,{waitUntil:"domcontentloaded"});
  const logs=page.getByRole("log",{name:"Live application logs"});await logs.getByText(`retained history for ${serviceA}`,{exact:true}).waitFor();
  latest(serviceA).response.write(frame("log",line("a-live","live private output from A")));await logs.getByText("live private output from A",{exact:true}).waitFor();
  const oldConnection=latest(serviceA);await page.getByLabel("Runtime service",{exact:true}).selectOption(serviceB);await logs.getByText(`retained history for ${serviceB}`,{exact:true}).waitFor();await expect.poll(()=>oldConnection.closed).toBe(true);await expect(logs.getByText("live private output from A",{exact:true})).toHaveCount(0);
  await page.evaluate(({serviceId})=>{for(const source of window.__fixtureEventSources.filter(source=>new URL(source.url).searchParams.get("serviceId")===serviceId)){source.dispatchEvent(new MessageEvent("log",{data:JSON.stringify({id:"late-a",timestamp:new Date().toISOString(),message:"late output from previous service"})}));source.dispatchEvent(new MessageEvent("access_revoked",{data:JSON.stringify({message:"Previous service authorization ended"})}));}},{serviceId:serviceA});
  await expect(logs.getByText("late output from previous service",{exact:true})).toHaveCount(0);await expect(page.getByText("Previous service authorization ended",{exact:true})).toHaveCount(0);await logs.getByText(`retained history for ${serviceB}`,{exact:true}).waitFor();
  // Positive control: an ordinary transport close reconnects through real browser SSE retry before terminal authorization revocation.
  const beforeDrop=count(serviceB),dropAt=Date.now();latest(serviceB).response.end();await expect.poll(()=>count(serviceB),{timeout:5000}).toBeGreaterThan(beforeDrop);await page.getByText("Streaming",{exact:true}).waitFor();const retryElapsed=Date.now()-dropAt;
  const active=latest(serviceB);active.response.write(frame("log",line("b-live","live private output from B")));await logs.getByText("live private output from B",{exact:true}).waitFor();
  const beforeRevocation=count(serviceB);active.response.end(frame("access_revoked",{message:"Workspace access was revoked. This stream has ended."})+frame("log",line("after-revoke","output arriving after revocation")));
  await page.getByText("Access ended",{exact:true}).waitFor();await page.getByText("Workspace access was revoked. This stream has ended.",{exact:true}).waitFor();await expect(logs.locator(".log-line")).toHaveCount(0);
  const readyState=await page.evaluate(serviceId=>window.__fixtureEventSources.filter(source=>new URL(source.url).searchParams.get("serviceId")===serviceId).at(-1).readyState,serviceB);assert.equal(readyState,2,"The native EventSource must be CLOSED after authorization revocation.");
  await page.evaluate(serviceId=>{const source=window.__fixtureEventSources.filter(source=>new URL(source.url).searchParams.get("serviceId")===serviceId).at(-1);source.dispatchEvent(new MessageEvent("connected",{data:JSON.stringify({generationId:"late-generation",history:[{id:"late-history",timestamp:new Date().toISOString(),message:"history received after access ended"}]})}));},serviceB);
  await expect(logs.locator(".log-line")).toHaveCount(0);await page.getByText("Access ended",{exact:true}).waitFor();
  await new Promise(resolve=>setTimeout(resolve,Math.min(Math.max(retryElapsed*3,400),1500)));assert.equal(count(serviceB),beforeRevocation,"Revoked access must not automatically reconnect.");assert.equal(latest(serviceB),undefined);assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(errors,[]);
  console.log("Focused real-EventSource service-switch isolation, log clearing, terminal access revocation and no automatic reconnect checks passed.");
}finally{
  if(browser)await browser.close();for(const connection of connections)connection.response.destroy();if(vite)await vite.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
