import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
const app=express(); const port=Number(process.env.PORT||3000);
app.get('/',(_q,r)=>r.json({framework:'express',ok:true}));
app.get('/health',async(_q,r)=>{try{const c=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME}); await c.query('SELECT 1'); await c.end();r.json({status:'ok',database:'mysql'})}catch(e){r.status(503).json({status:'error',message:String(e)})}});
app.listen(port,'0.0.0.0',()=>console.log(`listening ${port}`));
