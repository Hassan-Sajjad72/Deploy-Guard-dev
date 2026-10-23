'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

const MODES = [
  { value:'single',   label:'Single Dockerfile',  desc:'Stateless container with ALB and auto-scaling' },
  { value:'multi',    label:'Multi-Service',       desc:'Multiple services with internal networking' },
  { value:'database', label:'Persistent Database', desc:'Containerized DB with EFS persistent storage' },
];

export default function DeployPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name:'', repositoryUrl:'', branch:'main', dockerfilePath:'Dockerfile', mode:'single',
    config:{ targetUsers:100, enableAutoScaling:true, enableMonitoring:true, dbType:'postgres' },
  });

  const set = (k:string, v:any) => setForm(f=>({...f,[k]:v}));
  const setC = (k:string, v:any) => setForm(f=>({...f,config:{...f.config,[k]:v}}));

  const handleSubmit = async (e:React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try { await api.post('/deployments',form); router.push('/dashboard'); }
    catch(err:any){ setError(err.response?.data?.message||'Deployment failed.'); }
    finally{ setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-slate-900">
      <nav className="bg-slate-800 border-b border-slate-700 px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <button onClick={()=>router.back()} className="text-slate-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="font-semibold text-white">New Deployment</span>
        </div>
      </nav>
      <div className="max-w-2xl mx-auto px-4 py-8">
        {error && <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-white border-b border-slate-700 pb-3">Repository</h2>
            <div><label className="label">Deployment Name *</label>
              <input className="input" placeholder="my-awesome-app" value={form.name} onChange={e=>set('name',e.target.value)} required /></div>
            <div><label className="label">GitHub Repository URL *</label>
              <input className="input" placeholder="https://github.com/user/repo" value={form.repositoryUrl} onChange={e=>set('repositoryUrl',e.target.value)} required /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label">Branch</label>
                <input className="input" placeholder="main" value={form.branch} onChange={e=>set('branch',e.target.value)} /></div>
              <div><label className="label">Dockerfile Path</label>
                <input className="input" placeholder="Dockerfile" value={form.dockerfilePath} onChange={e=>set('dockerfilePath',e.target.value)} /></div>
            </div>
          </div>
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-white border-b border-slate-700 pb-3">Deployment Mode</h2>
            {MODES.map(m=>(
              <label key={m.value} className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-all ${
                form.mode===m.value?'border-blue-500 bg-blue-500/10':'border-slate-700 hover:border-slate-500'}`}>
                <input type="radio" name="mode" value={m.value} checked={form.mode===m.value}
                  onChange={e=>set('mode',e.target.value)} className="mt-0.5 accent-blue-500" />
                <div><div className="font-medium text-white">{m.label}</div><div className="text-sm text-slate-400">{m.desc}</div></div>
              </label>
            ))}
          </div>
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-white border-b border-slate-700 pb-3">Scaling & Monitoring</h2>
            <div><label className="label">Target Concurrent Users (1–200)</label>
              <input type="number" className="input" min={1} max={200}
                value={form.config.targetUsers} onChange={e=>setC('targetUsers',+e.target.value)} /></div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-blue-500" checked={form.config.enableAutoScaling}
                  onChange={e=>setC('enableAutoScaling',e.target.checked)} />
                <span className="text-sm text-slate-300">Auto-Scaling</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-blue-500" checked={form.config.enableMonitoring}
                  onChange={e=>setC('enableMonitoring',e.target.checked)} />
                <span className="text-sm text-slate-300">Prometheus Monitoring</span>
              </label>
            </div>
            {form.mode==='database' && (
              <div><label className="label">Database Engine</label>
                <select className="input" value={form.config.dbType} onChange={e=>setC('dbType',e.target.value)}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="mongodb">MongoDB</option>
                </select></div>
            )}
          </div>
          <button type="submit" className="btn-primary w-full py-3 text-base" disabled={loading}>
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Deploying...
              </span>
            ) : 'Deploy Application'}
          </button>
        </form>
      </div>
    </div>
  );
}
