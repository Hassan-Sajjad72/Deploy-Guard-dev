from pathlib import Path
import json,py_compile,sys
r=Path(__file__).resolve().parent;m=json.loads((r/'MATRIX.json').read_text());e=[]
for i in m:
 d=r/i['folder']
 for n in ['.env','.env.example','README.md','compose.yaml']:
  if not (d/n).exists():e.append(f"{i['folder']}: missing {n}")
 if not list(d.rglob('Dockerfile')):e.append(f"{i['folder']}: missing Dockerfile")
 env=(d/'.env').read_text() if (d/'.env').exists() else ''
 if not any(k in env for k in ['DATABASE_URL=','MONGODB_URI=','DB_HOST=']):e.append(f"{i['folder']}: no DB env evidence")
 for p in d.rglob('*.json'):
  try:json.loads(p.read_text())
  except Exception as x:e.append(f"{p.relative_to(r)} JSON: {x}")
 for p in d.rglob('*.py'):
  try:py_compile.compile(str(p),doraise=True)
  except Exception as x:e.append(f"{p.relative_to(r)} Python: {x}")
print('\n'.join(e) if e else f'PASS: {len(m)} fixtures; required files, DB ENV, JSON, Python syntax validated');sys.exit(bool(e))
