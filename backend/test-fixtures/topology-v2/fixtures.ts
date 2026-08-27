export type TopologyFixture = {
  name: string;
  files: Record<string, string>;
  shape: string;
  state: "SUPPORTED" | "INPUT_REQUIRED" | "UNRESOLVED" | "UNSUPPORTED";
  database?: "postgres" | "mysql" | "mongodb";
};

const pkg = (dependencies: Record<string, string>, scripts: Record<string, string>) => JSON.stringify({ packageManager: "npm@10.8.0", engines: { node: ">=22 <23" }, scripts, dependencies });
const vite = (root = ".") => ({ [`${root === "." ? "" : `${root}/`}package.json`]: pkg({ react: "19", vite: "6" }, { build: "vite build" }), [`${root === "." ? "" : `${root}/`}package-lock.json`]: "{}", [`${root === "." ? "" : `${root}/`}src/App.jsx`]: "export const load=()=>fetch('/api/health')" });
const express = (root = ".", dependencies: Record<string, string> = {}, source = "app.get('/health',(_,r)=>r.send('ok'))") => ({ [`${root === "." ? "" : `${root}/`}package.json`]: pkg({ express: "5", ...dependencies }, { start: "node server.js" }), [`${root === "." ? "" : `${root}/`}package-lock.json`]: "{}", [`${root === "." ? "" : `${root}/`}server.js`]: `const express=require('express');const app=express();${source};app.listen(process.env.PORT||3000,'0.0.0.0')` });
const python = (framework: string, file: string, source: string) => ({ "requirements.txt": `${framework}==${framework === "Django" ? "5.2.0" : "3.1.0"}\n`, [file]: source });

export const topologyFixtures: TopologyFixture[] = [
  { name: "01-static-vite", files: vite(), shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "02-express-api", files: express(), shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "03-nest-api", files: { "package.json": pkg({ "@nestjs/core": "11" }, { build: "nest build", "start:prod": "node dist/main.js" }), "package-lock.json": "{}", "nest-cli.json": "{}", "src/main.ts": "app.listen(process.env.PORT||3000,'0.0.0.0')" }, shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "04-flask-api", files: python("Flask", "app.py", "from flask import Flask\napp=Flask(__name__)"), shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "05-fastapi-api", files: { "requirements.txt": "fastapi==0.116.0\n", "main.py": "from fastapi import FastAPI\napp=FastAPI()" }, shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "06-django-api", files: { "requirements.txt": "Django==5.2.0\n", "manage.py": "", "config/wsgi.py": "application=object()" }, shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "07-express-serves-vite", files: { "package.json": pkg({ react: "19", vite: "6", express: "5" }, { build: "vite build", start: "node server.js" }), "package-lock.json": "{}", "src/App.jsx": "export default ()=>null", "server.js": "const path=require('path');const express=require('express');const app=express();const output=path.join(__dirname,'dist');app.use(express.static(output));app.get('/api/health',(_,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')" }, shape: "MONOLITH_SERVES_FRONTEND", state: "SUPPORTED" },
  { name: "08-nest-serves-static-frontend", files: { "package.json": pkg({ react: "19", vite: "6", "@nestjs/core": "11", "@nestjs/serve-static": "5" }, { build: "vite build", "start:prod": "node dist/main.js" }), "package-lock.json": "{}", "nest-cli.json": "{}", "src/main.ts": "ServeStaticModule.forRoot({rootPath:path.join(__dirname,'dist')});app.listen(process.env.PORT||3000,'0.0.0.0')" }, shape: "MONOLITH_SERVES_FRONTEND", state: "SUPPORTED" },
  { name: "09-flask-serves-vite", files: { ...vite(), "requirements.txt": "Flask==3.1.0\n", "app.py": "from flask import Flask\napp=Flask(__name__, static_folder='dist')" }, shape: "PYTHON_SERVES_FRONTEND", state: "SUPPORTED" },
  { name: "10-fastapi-serves-vite", files: { ...vite(), "requirements.txt": "fastapi==0.116.0\n", "main.py": "from fastapi import FastAPI\nfrom fastapi.staticfiles import StaticFiles\napp=FastAPI()\napp.mount('/',StaticFiles(directory='dist'))" }, shape: "PYTHON_SERVES_FRONTEND", state: "SUPPORTED" },
  { name: "11-separated-vite-express", files: { ...vite("web"), ...express("api", {}, "app.get('/health',(_,r)=>r.send('ok'))") }, shape: "DECOUPLED_FRONTEND_BACKEND", state: "SUPPORTED" },
  { name: "12-separated-vite-fastapi", files: { ...vite("web"), "api/requirements.txt": "fastapi==0.116.0\n", "api/main.py": "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/health')\ndef health():return 'ok'" }, shape: "DECOUPLED_FRONTEND_BACKEND", state: "SUPPORTED" },
  { name: "13-client-server-layout", files: { ...vite("client"), ...express("server") }, shape: "DECOUPLED_FRONTEND_BACKEND", state: "SUPPORTED" },
  { name: "14-apps-web-api-workspace", files: { "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...vite("apps/web"), ...express("apps/api") }, shape: "BOUNDED_MONOREPO", state: "SUPPORTED" },
  { name: "15-next-ssr", files: { "package.json": pkg({ next: "15", react: "19" }, { build: "next build", start: "next start" }), "package-lock.json": "{}" }, shape: "SSR_APPLICATION", state: "SUPPORTED" },
  { name: "16-custom-server-ssr", files: { "package.json": pkg({ next: "15", react: "19", express: "5" }, { build: "next build", start: "node server.js" }), "package-lock.json": "{}", "server.js": "const next=require('next');const app=next({dev:false});const handle=app.getRequestHandler();server.listen(process.env.PORT||3000,'0.0.0.0')" }, shape: "CUSTOM_SERVER_SSR", state: "SUPPORTED" },
  { name: "17-managed-mongodb", files: express(".", { mongoose: "8" }, "mongoose.connect(process.env.MONGODB_URI);app.get('/health',(_,r)=>r.send('ok'))"), shape: "BACKEND_API", state: "SUPPORTED", database: "mongodb" },
  { name: "18-managed-postgresql", files: express(".", { pg: "8" }, "new Pool({connectionString:process.env.DATABASE_URL});app.get('/health',(_,r)=>r.send('ok'))"), shape: "BACKEND_API", state: "SUPPORTED", database: "postgres" },
  { name: "19-managed-mysql", files: express(".", { mysql2: "3" }, "mysql.createConnection({host:process.env.DB_HOST});app.get('/health',(_,r)=>r.send('ok'))"), shape: "BACKEND_API", state: "SUPPORTED", database: "mysql" },
  { name: "20-required-private-env", files: express(".", {}, "if(!process.env.JWT_SECRET)throw Error('required');app.get('/health',(_,r)=>r.send('ok'))"), shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "21-optional-public-env", files: { ...vite(), "src/App.jsx": "const key=import.meta.env.VITE_WEATHER_API_KEY||'';export default key" }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "22-frontend-db-no-owner-invalid", files: { "package.json": pkg({ react: "19", vite: "6", mongoose: "8" }, { build: "vite build" }), "package-lock.json": "{}", "src/App.jsx": "const uri=import.meta.env.VITE_MONGODB_URI" }, shape: "UNRESOLVED", state: "UNRESOLVED" },
  { name: "23-two-backends-ambiguous", files: { ...express("api-a"), ...express("api-b") }, shape: "UNRESOLVED", state: "INPUT_REQUIRED" },
  { name: "24-two-frontends-ambiguous", files: { ...vite("web-a"), ...vite("web-b") }, shape: "UNRESOLVED", state: "UNRESOLVED" },
  { name: "25-generic-orm-ambiguous", files: express(".", { prisma: "6", "@prisma/client": "6" }, "new PrismaClient();app.get('/health',(_,r)=>r.send('ok'))"), shape: "UNRESOLVED", state: "UNRESOLVED" },
  { name: "26-hardcoded-external-backend", files: { ...vite("web"), "web/src/App.jsx": "fetch('https://sample.railway.app/api')", ...express("api") }, shape: "DECOUPLED_FRONTEND_BACKEND", state: "SUPPORTED" },
  { name: "27-required-worker-unsupported", files: { "package.json": pkg({ express: "5" }, { start: "node server.js", worker: "node worker.js" }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT||3000,'0.0.0.0')", "worker.js": "consumeQueue()" }, shape: "UNSUPPORTED", state: "UNSUPPORTED" },
  { name: "28-workspace-library-not-service", files: { "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }), "package-lock.json": "{}", ...express("apps/api"), "packages/shared/package.json": pkg({ react: "19" }, {}) }, shape: "BACKEND_API", state: "SUPPORTED" },
  { name: "29-dynamic-static-path-unresolved", files: { "package.json": pkg({ react: "19", vite: "6", express: "5" }, { build: "vite build", start: "node server.js" }), "package-lock.json": "{}", "src/App.jsx": "export default ()=>null", "server.js": "const express=require('express');const app=express();app.use(express.static(getOutputDirectory()));app.get('/api/health',(_,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')" }, shape: "UNRESOLVED", state: "UNRESOLVED" },
  { name: "30-unsupported-stack", files: { "composer.json": "{}", "index.php": "<?php echo 'ok';" }, shape: "UNSUPPORTED", state: "UNSUPPORTED" },
  {
    name: "31-django-postgresql",
    files: {
      "requirements.txt": "Django==5.2.0\npsycopg2==2.9.10\ngunicorn==23.0.0\n",
      "manage.py": "",
      "config/wsgi.py": "application=object()",
      "config/settings.py": "import os\nDATABASES={'default':{'ENGINE':'django.db.backends.postgresql','HOST':os.environ['DB_HOST'],'PORT':os.environ['DB_PORT'],'NAME':os.environ['DB_NAME'],'USER':os.environ['DB_USER'],'PASSWORD':os.environ['DB_PASSWORD']}}",
    },
    shape: "BACKEND_API",
    state: "SUPPORTED",
    database: "postgres",
  },
  {
    name: "32-separated-vite-django-postgresql",
    files: {
      ...vite("web"),
      "api/requirements.txt": "Django==5.2.0\npsycopg2==2.9.10\ngunicorn==23.0.0\n",
      "api/manage.py": "",
      "api/config/wsgi.py": "application=object()",
      "api/config/settings.py": "import os\nDATABASES={'default':{'ENGINE':'django.db.backends.postgresql','HOST':os.environ['DB_HOST'],'PORT':os.environ['DB_PORT'],'NAME':os.environ['DB_NAME'],'USER':os.environ['DB_USER'],'PASSWORD':os.environ['DB_PASSWORD']}}",
      "api/config/urls.py": "from django.urls import path\nfrom django.http import JsonResponse\nurlpatterns=[path('api/health',lambda request: JsonResponse({'ok':True}))]",
    },
    shape: "DECOUPLED_FRONTEND_BACKEND",
    state: "SUPPORTED",
    database: "postgres",
  },
  {
    name: "33-required-react-native-sibling",
    files: {
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "package-lock.json": "{}",
      ...vite("apps/web"),
      "apps/mobile/package.json": pkg({ react: "19", "react-native": "0.76" }, { start: "react-native start", android: "react-native run-android" }),
      "apps/mobile/package-lock.json": "{}",
      "apps/mobile/App.jsx": "export default function App(){return null}",
    },
    shape: "UNSUPPORTED",
    state: "UNSUPPORTED",
  },
];

export const additionalFrameworkFixtures: TopologyFixture[] = [
  { name: "vue-vite", files: { "package.json": pkg({ vue: "3", vite: "6" }, { build: "vite build" }), "package-lock.json": "{}" }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "nuxt-ssr", files: { "package.json": pkg({ nuxt: "3" }, { build: "nuxt build" }), "package-lock.json": "{}", "nuxt.config.ts": "export default {}" }, shape: "SSR_APPLICATION", state: "SUPPORTED" },
  { name: "angular", files: { "package.json": pkg({ "@angular/core": "19" }, { build: "ng build" }), "package-lock.json": "{}", "angular.json": JSON.stringify({ defaultProject: "app", projects: { app: { architect: { build: { options: { outputPath: "dist/app" } } } } } }) }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "angular-multiple-projects-without-default", files: { "package.json": pkg({ "@angular/core": "19" }, { build: "ng build" }), "package-lock.json": "{}", "angular.json": JSON.stringify({ projects: { "a-decoy": { architect: { build: { options: { outputPath: "dist/decoy" } } } }, "z-intended": { architect: { build: { options: { outputPath: "dist/intended" } } } } } }) }, shape: "UNSUPPORTED", state: "UNSUPPORTED" },
  { name: "plain-static-arbitrary-directory", files: { "dashboard/index.html": "<html><head><link href='app.css' rel='stylesheet'></head><body><script src='app.js'></script></body></html>", "dashboard/app.js": "document.body.dataset.ready='true'", "dashboard/app.css": "body{margin:0}" }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "workspace-install-root-preserved", files: { "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }), "package-lock.json": "{}", ...vite("apps/web"), "packages/shared/package.json": pkg({ lodash: "4" }, {}) }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "postgresql-plus-redis-cache", files: express(".", { pg: "8", ioredis: "5" }, "new Pool({connectionString:process.env.DATABASE_URL});new Redis(process.env.REDIS_URL);app.get('/health',(_,r)=>r.send('ok'))"), shape: "BACKEND_API", state: "SUPPORTED", database: "postgres" },
  { name: "nested-workspace-worker-unsupported", files: { "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...express("apps/api"), "apps/worker/package.json": pkg({ bullmq: "5" }, { worker: "node worker.js" }), "apps/worker/worker.js": "const { Worker }=require('bullmq');new Worker('jobs', async () => {})" }, shape: "UNSUPPORTED", state: "UNSUPPORTED" },
  { name: "sveltekit", files: { "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" }, { build: "vite build" }), "package-lock.json": "{}", "svelte.config.js": "import adapter from '@sveltejs/adapter-node';export default{kit:{adapter:adapter()}}" }, shape: "SSR_APPLICATION", state: "SUPPORTED" },
  { name: "astro", files: { "package.json": pkg({ astro: "5" }, { build: "astro build" }), "package-lock.json": "{}", "astro.config.mjs": "export default {output:'static'}" }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "remix", files: { "package.json": pkg({ "@remix-run/node": "2", "@remix-run/serve": "2" }, { build: "remix vite:build", start: "remix-serve build/server/index.js" }), "package-lock.json": "{}" }, shape: "SSR_APPLICATION", state: "SUPPORTED" },
  { name: "cra", files: { "package.json": pkg({ react: "18", "react-scripts": "5" }, { build: "react-scripts build" }), "package-lock.json": "{}" }, shape: "STATIC_FRONTEND", state: "SUPPORTED" },
  { name: "streamlit", files: { "requirements.txt": "streamlit==1.47.0\n", "app.py": "import streamlit as st\nst.write('ok')" }, shape: "SSR_APPLICATION", state: "SUPPORTED" },
  {
    name: "global-online-learning-academy-process-cwd-static",
    files: {
      "package.json": pkg({ react: "19", vite: "6", express: "4", mongoose: "9", jsonwebtoken: "9" }, { build: "vite build", start: "tsx server.ts" }),
      "package-lock.json": "{}",
      "src/App.jsx": "export default ()=>null",
      "vite.config.ts": "export default { server: { hmr: process.env.DISABLE_HMR !== 'true' } }",
      "server.ts": `import express from 'express';import mongoose from 'mongoose';import path from 'path';
const app=express();const JWT_SECRET=process.env.JWT_SECRET||'';mongoose.connect(process.env.MONGODB_URI||'mongodb://localhost/app');
app.get('/api/health',(_,res)=>res.send('ok'));const distPath=path.join(process.cwd(),'dist');app.use(express.static(distPath));app.get('*',(_,res)=>res.sendFile(path.join(distPath,'index.html')));app.listen(process.env.PORT||3000,'0.0.0.0');`,
    },
    shape: "MONOLITH_SERVES_FRONTEND",
    state: "SUPPORTED",
    database: "mongodb",
  },
];
