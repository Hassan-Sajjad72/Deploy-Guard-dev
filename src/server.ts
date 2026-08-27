import 'dotenv/config';
import express from 'express';
import {MongoClient} from 'mongodb'; const client=new MongoClient(process.env.MONGODB_URI);
const app=express(); const port=Number(process.env.PORT||3000);
app.get('/',(_q,r)=>r.json({framework:'express-ts',ok:true}));
app.get('/health',async(_q,r)=>{try{await client.connect(); await client.db().command({ping:1});r.json({status:'ok',database:'mongodb'})}catch(e){r.status(503).json({status:'error',message:String(e)})}});
app.listen(port,'0.0.0.0',()=>console.log(`listening ${port}`));
