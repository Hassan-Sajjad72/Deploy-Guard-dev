
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine

app = FastAPI(title="Core API")

@app.get("/health")
def health():
    return {"status": "ok"}
