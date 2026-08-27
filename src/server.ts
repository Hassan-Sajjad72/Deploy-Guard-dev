import 'dotenv/config';
import Fastify from 'fastify';
import pg from 'pg'; const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const app=Fastify({logger:true});
app.get('/',async()=>({framework:'fastify-ts',ok:true}));
app.get('/health',async(_q,reply)=>{try{await pool.query('SELECT 1');return {status:'ok',database:'postgres'}}catch(e){reply.code(503);return {status:'error',message:String(e)}}});
await app.listen({port:Number(process.env.PORT||3000),host:'0.0.0.0'});
