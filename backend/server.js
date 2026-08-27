import 'dotenv/config';
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
const app=Fastify({logger:true});
app.get('/',async()=>({framework:'fastify',ok:true}));
app.get('/health',async(_q,reply)=>{try{const c=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME}); await c.query('SELECT 1'); await c.end();return {status:'ok',database:'mysql'}}catch(e){reply.code(503);return {status:'error',message:String(e)}}});
await app.listen({port:Number(process.env.PORT||3000),host:'0.0.0.0'});
