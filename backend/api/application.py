import os
import psycopg
from fastapi import FastAPI
from dotenv import load_dotenv
load_dotenv(); app=FastAPI()
@app.get('/')
def root(): return {'framework':'fastapi-nested','ok':True}
@app.get('/health')
def health():
 with psycopg.connect(os.environ['DATABASE_URL']) as c:
  with c.cursor() as q: q.execute('SELECT 1'); q.fetchone()
 return {'status':'ok','database':'postgresql'}
