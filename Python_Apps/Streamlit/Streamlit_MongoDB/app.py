import os
import streamlit as st
from pymongo import MongoClient
from dotenv import load_dotenv
load_dotenv(); st.title('DeployGuard Streamlit Fixture')
try: MongoClient(os.environ['MONGODB_URI'],serverSelectionTimeoutMS=3000).admin.command('ping'); st.success('MongoDB connected')
except Exception as e: st.error(str(e))
