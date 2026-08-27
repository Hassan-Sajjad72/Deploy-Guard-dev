import 'dotenv/config';
import Fastify from 'fastify';
import {MongoClient} from 'mongodb'; const client=new MongoClient(process.env.MONGODB_URI);
const app=Fastify({logger:true});
app.get('/',async()=>({framework:'fastify',ok:true}));
app.get('/health',async(_q,reply)=>{try{await client.connect(); await client.db().command({ping:1});return {status:'ok',database:'mongodb'}}catch(e){reply.code(503);return {status:'error',message:String(e)}}});
await app.listen({port:Number(process.env.PORT||3000),host:'0.0.0.0'});
