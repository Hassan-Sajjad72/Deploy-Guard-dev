import 'dotenv/config';
import express from 'express';
import pg from 'pg'; const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const app=express(); const port=Number(process.env.PORT||3000);
app.get('/',(_q,r)=>r.json({framework:'express',ok:true}));
app.get('/health',async(_q,r)=>{try{await pool.query('SELECT 1');r.json({status:'ok',database:'postgres'})}catch(e){r.status(503).json({status:'error',message:String(e)})}});
app.listen(port,'0.0.0.0',()=>console.log(`listening ${port}`));
