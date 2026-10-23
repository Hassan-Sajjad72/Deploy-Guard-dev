'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

const STATUS_COLOR: Record<string,string> = {
  running:'text-green-400 bg-green-500/20', building:'text-yellow-400 bg-yellow-500/20',
  deploying:'text-blue-400 bg-blue-500/20', pending:'text-slate-400 bg-slate-500/20',
  failed:'text-red-400 bg-red-500/20', stopped:'text-slate-500 bg-slate-700/50',
  rolled_back:'text-orange-400 bg-orange-500/20',
};
const DOT: Record<string,string> = {
  running:'bg-green-500', building:'bg-yellow-400 animate-pulse', deploying:'bg-blue-400 animate-pulse',
  pending:'bg-slate-400 animate-pulse', failed:'bg-red-500', stopped:'bg-slate-600', rolled_back:'bg-orange-400',
};

export default function DashboardPage() {
  const router = useRouter();
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string|null>(null);

  const fetch = useCallback(async () => {
    try {
      const res = await api.get('/deployments');
      setDeployments(res.data);
    } catch (e: any) { if (e.response?.status === 401) router.replace('/login'); }
    finally { setLoading(false); }
  }, [router]);

  useEffect(() => {
    if (!localStorage.getItem('dg_token')) { router.replace('/login'); return; }
    fetch();
    const iv = setInterval(fetch, 8000);
    return () => clearInterval(iv);
  }, [fetch, router]);

  const stats = {
    total: deployments.length,
    running: deployments.filter(d=>d.status==='running').length,
    building: deployments.filter(d=>['pending','building','deploying'].includes(d.status)).length,
    failed: deployments.filter(d=>d.status==='failed').length,
  };

  return (
    <div className="min-h-screen bg-slate-900">
      <nav className="bg-slate-800 border-b border-slate-700 px-4 py-3 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-white text-lg">
            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            DeployGuard
          </div>
          <div className="flex items-center gap-4">
            <button onClick={()=>router.push('/deploy')} className="btn-primary py-1.5 px-3 text-sm">+ Deploy</button>
            <button onClick={()=>{localStorage.removeItem('dg_token');router.replace('/login');}}
              className="text-slate-400 hover:text-red-400 text-sm transition-colors">Sign Out</button>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-slate-400 text-sm mt-1">Monitor and manage your deployments</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[{l:'Total',v:stats.total,c:'border-blue-500/30 text-blue-400'},
            {l:'Running',v:stats.running,c:'border-green-500/30 text-green-400'},
            {l:'Building',v:stats.building,c:'border-yellow-500/30 text-yellow-400'},
            {l:'Failed',v:stats.failed,c:'border-red-500/30 text-red-400'}
          ].map(s=>(
            <div key={s.l} className={`bg-slate-800 border rounded-xl p-4 ${s.c}`}>
              <div className="text-3xl font-bold">{s.v}</div>
              <div className="text-sm opacity-80 mt-1">{s.l}</div>
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
          </div>
        ) : deployments.length === 0 ? (
          <div className="card text-center py-16">
            <svg className="w-16 h-16 text-slate-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <h3 className="text-lg font-semibold text-slate-300 mb-2">No deployments yet</h3>
            <p className="text-slate-500 mb-6">Deploy your first application to get started</p>
            <button onClick={()=>router.push('/deploy')} className="btn-primary">Create Deployment</button>
          </div>
        ) : (
          <div className="space-y-4">
            {deployments.map(d=>(
              <div key={d.id} className="card hover:border-slate-600 transition-all">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${DOT[d.status]||'bg-slate-500'}`} />
                    <div className="min-w-0">
                      <h3 className="font-semibold text-white truncate">{d.name}</h3>
                      <p className="text-slate-400 text-sm truncate">{d.repositoryUrl}</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full capitalize">{d.mode}</span>
                        <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">{d.branch||'main'}</span>
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize flex-shrink-0 ${STATUS_COLOR[d.status]||''}`}>
                    {d.status?.replace('_',' ')}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-slate-700">
                  <button onClick={()=>setExpanded(expanded===d.id?null:d.id)} className="text-xs btn-secondary py-1.5 px-3">
                    {expanded===d.id?'Hide Logs':'View Logs'}
                  </button>
                  {['running','failed'].includes(d.status) && (
                    <button onClick={async()=>{await api.post(`/deployments/${d.id}/rollback`);fetch();}}
                      className="text-xs bg-orange-600 hover:bg-orange-700 text-white py-1.5 px-3 rounded-lg transition-all">Rollback</button>
                  )}
                  {d.status!=='stopped' && (
                    <button onClick={async()=>{if(confirm('Destroy this deployment?')){await api.delete(`/deployments/${d.id}`);fetch();}}}
                      className="text-xs btn-danger py-1.5 px-3 ml-auto">Destroy</button>
                  )}
                </div>
                {expanded===d.id && (
                  <div className="mt-4 bg-slate-950 rounded-lg p-4 font-mono text-xs text-green-400 max-h-56 overflow-y-auto">
                    <pre className="whitespace-pre-wrap">{d.logs||'No logs available yet...'}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
