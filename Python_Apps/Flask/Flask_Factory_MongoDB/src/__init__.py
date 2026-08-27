import os
from flask import Flask,jsonify
from pymongo import MongoClient
from dotenv import load_dotenv
def create_app():
 load_dotenv(); app=Flask(__name__); client=MongoClient(os.environ['MONGODB_URI'],serverSelectionTimeoutMS=3000)
 @app.get('/')
 def root(): return jsonify(framework='flask-factory',ok=True)
 @app.get('/health')
 def health(): client.admin.command('ping'); return jsonify(status='ok',database='mongodb')
 return app
