import os
from flask import Flask,jsonify
import psycopg
from dotenv import load_dotenv
load_dotenv(); app=Flask(__name__)
@app.get('/')
def root(): return jsonify(framework='flask',ok=True)
@app.get('/health')
def health():
 with psycopg.connect(os.environ['DATABASE_URL']) as c:
  with c.cursor() as q: q.execute('SELECT 1'); q.fetchone()
 return jsonify(status='ok',database='postgresql')
