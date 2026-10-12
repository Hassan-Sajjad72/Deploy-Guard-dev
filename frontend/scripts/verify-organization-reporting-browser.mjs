import {strict as assert} from "node:assert";
import {chromium,expect} from "@playwright/test";
import {createServer} from "vite";
const server=await createServer({define:{"import.meta.env.VITE_API_BASE_URL":JSON.stringify("")},server:{host:"127.0.0.1",port:0},logLevel:"error"});let browser;
try{
  await server.listen();browser=await chromium.launch({executablePath:process.env.DG_CHROME_BIN||"/usr/bin/google-chrome",args:["--no-sandbox"],headless:true});const page=await browser.newPage(),errors=[],requests=[];
  page.on("pageerror",error=>errors.push(error.message));let adminRole="platform_ops",accountChanges=0,identityVerified=false;
  const accounts=[{id:"9",name:"Customer engineer",email:"engineer@example.invalid",provider:"github",githubLogin:"engineer",role:"developer",enabled:true},{id:"10",name:"Second account",email:"second@example.invalid",provider:"github",githubLogin:"second",role:"developer",enabled:true}];
  const workspaces=[{id:"team",name:"Team workspace",kind:"team",role:"owner"},{id:"agency",name:"Agency workspace",kind:"agency",role:"owner"}];
  const summaries=[
    {project:{id:"one",name:"Team production",organizationId:"team",environmentName:"prod",repositoryFullName:"fixture/one"},currentState:{stableRelease:{commit:"a".repeat(40),generationId:"generation",promotedAt:new Date().toISOString()},stateAuthority:{state:"LIVE",runtime:{state:"present",source:"verified_release"},applicationHealth:{status:"unavailable"}}}},
    {project:{id:"two",name:"Team development",organizationId:"team",environmentName:"dev",repositoryFullName:"fixture/two"},currentState:{stateAuthority:{state:"READY",applicationHealth:{status:"unavailable"}}}},
    {project:{id:"three",name:"Client application",organizationId:"agency",environmentName:"prod",clientId:"client",engagementId:"engagement",repositoryFullName:"fixture/three"},currentState:{stateAuthority:{state:"FAILED",applicationHealth:{status:"failed"}}}}
  ];
  await page.route("**/api/**",async route=>{const path=new URL(route.request().url()).pathname;if(!path.startsWith("/api/")){await route.continue();return;}requests.push(path);let body;
    if(path==="/api/auth/me")body={user:{id:1,role:"developer",githubLogin:"owner"}};
    else if(path==="/api/projects/workspace-summary")body={summaries,needsAttention:[summaries[2]]};
    else if(path==="/api/workspaces")body={workspaces};
    else if(path==="/api/workspaces/agency/portfolio")body={clients:[{id:"client",name:"Customer"}],engagements:[{id:"engagement",name:"Customer engagement",clientId:"client"}]};
    else if(path==="/api/admin-auth/me")body={user:{id:8,role:"admin",internalAdminRole:adminRole,email:"operator@example.invalid"}};
    else if(path==="/api/admin/overview")body={generatedAt:new Date().toISOString(),counts:{projects:3,activeOperations:0,failedOperations:1,destroyingOperations:0},services:{}};
    else if(path==="/api/admin/organizations")body={organizations:workspaces.map(item=>({...item,members:1,projects:item.id==="team"?2:1}))};
    else if(path==="/api/admin/projects")body={summaries:summaries.map(({project})=>({project:{...project,status:"created",operationStatus:project.id==="three"?"failed":"completed"},currentState:null}))};
    else if(path==="/api/admin/users")body={users:accounts};
    else if(path==="/api/admin/verify-identity"){identityVerified=true;body={expiresAt:new Date(Date.now()+900000).toISOString()};}
    else if(path==="/api/admin/users/9/role"){assert.ok(identityVerified);const input=route.request().postDataJSON();assert.equal(input.reason,"Reviewed read access only.");assert.equal(input.role,"readonly");accountChanges++;accounts[0].role=input.role;body={user:accounts[0]};}
    else if(path==="/api/admin/audit-logs")body={logs:[],pagination:{page:1,limit:20,total:0,totalPages:1}};
    else if(path.includes("/activity"))body={};else{await route.fulfill({status:404,json:{message:`Unexpected fixture ${path}`}});return;}await route.fulfill({json:body});
  });
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;await page.goto(`${origin}/projects`,{waitUntil:"domcontentloaded"});const dashboard=page.getByRole("region",{name:"Organization dashboard"});try{await dashboard.waitFor();}catch(error){console.error({errors,requests,body:await page.locator("body").innerText()});throw error;}
  const count=async name=>Number(await dashboard.locator("dl > div").filter({has:page.getByText(name,{exact:true})}).locator("dd").innerText());
  assert.equal(await count("Projects"),3);assert.equal(await count("Verified releases"),1);assert.equal(await count("Healthy applications"),0);assert.equal(await count("Operational alerts"),1);
  await page.getByLabel("Workspace",{exact:true}).selectOption("team");await expect(page.locator(".projects-list > li")).toHaveCount(2);assert.equal(await count("Health unverified"),2);
  await page.getByLabel("Environment",{exact:true}).selectOption("prod");await expect(page.locator(".projects-list > li")).toHaveCount(1);await page.getByText("Verified release aaaaaaaaaaaa · Health: unverified",{exact:true}).waitFor();assert.match(page.url(),/environment=prod/);
  await page.getByLabel("Workspace",{exact:true}).selectOption("agency");await page.getByLabel("Client",{exact:true}).selectOption("client");await page.getByLabel("Engagement",{exact:true}).selectOption("engagement");await expect(page.locator(".projects-list > li")).toHaveCount(1);assert.equal(await count("Failed health checks"),1);await dashboard.getByText("Operational alerts (1)",{exact:true}).click();await dashboard.getByText("The application health check failed.",{exact:false}).waitFor();
  await page.getByRole("searchbox",{name:"Search projects",exact:true}).fill("absent");await page.getByRole("button",{name:"Clear filters",exact:true}).click();await expect(page.locator(".projects-list > li")).toHaveCount(3);assert.equal(new URL(page.url()).search,"");
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await page.goto(`${origin}/admin?section=projects`,{waitUntil:"domcontentloaded"});await page.getByRole("searchbox",{name:"Search authorized project records",exact:true}).waitFor();assert.equal(requests.includes("/api/admin/users"),false);
  await page.getByLabel("Project organization",{exact:true}).selectOption("agency");await expect(page.getByRole("region",{name:"Projects and operations"}).locator("tbody tr")).toHaveCount(1);await page.getByRole("searchbox",{name:"Search authorized project records",exact:true}).fill("Client application");await expect(page.getByRole("region",{name:"Projects and operations"}).locator("tbody tr")).toHaveCount(1);assert.equal(await page.getByText("Account #undefined",{exact:true}).count(),0);
  requests.length=0;adminRole="security_auditor";await page.goto(`${origin}/admin?section=projects`,{waitUntil:"domcontentloaded"});await page.getByRole("heading",{name:"Audit log",exact:true}).waitFor();assert.equal(requests.includes("/api/admin/projects"),false);assert.equal(requests.includes("/api/admin/users"),false);assert.equal(await page.getByRole("searchbox",{name:"Search authorized project records",exact:true}).count(),0);
  adminRole="super_admin";await page.goto(`${origin}/admin?section=users`,{waitUntil:"domcontentloaded"});await page.getByRole("searchbox",{name:"Search authorized users",exact:true}).fill("Customer engineer");await expect(page.getByRole("region",{name:"Users and roles"}).locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Reason for account role change",{exact:true}).fill("Reviewed read access only.");await page.getByLabel("User role",{exact:true}).selectOption("readonly");await page.getByText("Verify your administrator identity before changing an account role.",{exact:true}).waitFor();assert.equal(accountChanges,0);
  await page.getByLabel("Confirm administrator password",{exact:true}).fill("fixture-only");await page.getByRole("button",{name:"Verify identity for sensitive actions",exact:true}).click();await page.getByText("Identity verified until",{exact:false}).waitFor();await page.getByLabel("User role",{exact:true}).selectOption("readonly");await page.getByText("Role updated.",{exact:true}).waitFor();assert.equal(accountChanges,1);
  assert.deepEqual(errors,[]);console.log("Focused workspace/environment/client dashboard, independent release health, admin search scope and mobile reporting browser checks passed.");
}finally{if(browser)await browser.close();await server.close();}
