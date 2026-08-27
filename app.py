import os
from fastapi import FastAPI
import mysql.connector
from dotenv import load_dotenv
load_dotenv(); app=FastAPI()
@app.get('/')
def root(): return {'framework':'fastapi','ok':True}
@app.get('/health')
def health():
 c=mysql.connector.connect(host=os.environ['DB_HOST'],port=int(os.environ['DB_PORT']),user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'],database=os.environ['DB_NAME']); q=c.cursor(); q.execute('SELECT 1'); q.fetchone(); q.close(); c.close(); return {'status':'ok','database':'mysql'}
