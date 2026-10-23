import os
import asyncpg
import uvicorn
from fastapi import FastAPI

app = FastAPI()

@app.get("/db")
async def database_status():
    connection = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        result = await connection.fetchval("SELECT 1")
        return {"db": "connected" if result == 1 else "unexpected"}
    finally:
        await connection.close()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
