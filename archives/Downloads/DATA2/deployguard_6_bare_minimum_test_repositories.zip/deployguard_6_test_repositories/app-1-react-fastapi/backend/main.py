import os
import uvicorn
from fastapi import FastAPI

app = FastAPI()

@app.get("/api/ping")
def ping():
    return {"message": "pong"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
