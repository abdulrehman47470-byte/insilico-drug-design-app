'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

interface Lipinski {
  mw: number; logp: number; hbd: number; hba: number
  rotb: number; tpsa: number; violations: number
  drug_like: boolean; passes_ro5: boolean
}
interface ADME {
  lipinski: Lipinski
  absorption: { gi_absorption: string; bbb_penetrant: boolean }
  distribution: { plasma_protein_binding: string }
  metabolism: { cyp_inhibition_risk: string }
  excretion: { solubility_class: string; esol_log: number }
  overall_score: number
}
interface DrugCandidate {
  rank: number; name: string; smiles: string; source: string
  pchembl: number; affinity_kcal_mol: number; class: string
  combined_score: number; adme: ADME
}
interface Gene { symbol: string; rank: number; total: number; source: string }
interface FinalReport {
  disease: string; pipeline_id: string; timestamp: string
  gene: { primary: string; ranked: Gene[]; score: number }
  sequences: { mrna_retrieved: boolean; protein_length: number; protein_mass: number }
  protein: { uniprot_id: string; name: string; length: number; function: string; subcellular_location: string }
  secondary_structure: { method: string; alpha_helix_pct: number; beta_sheet_pct: number; coil_pct: number; summary: string; length: number }
  tertiary_structure: { source: string; plddt: number; grade: string; residues: number }
  docking_results: DrugCandidate[]
  top_candidate: { name: string; smiles: string; affinity: number; class: string; drug_like: boolean; score: number }
  files: Record<string, string>
}

const STEPS = [
  { id: 'pubmed',    label: 'PubMed',        sub: 'Literature mining',  cumulative: 18  },
  { id: 'genes',     label: 'Gene Analysis', sub: 'Target ranking',     cumulative: 38  },
  { id: 'protein',   label: 'Protein',       sub: 'UniProt / Ensembl',  cumulative: 62  },
  { id: 'structure', label: '3D Structure',  sub: 'AlphaFold / RCSB',   cumulative: 105 },
  { id: 'ligands',   label: 'Ligands',       sub: 'ChEMBL / PubChem',   cumulative: 155 },
  { id: 'docking',   label: 'Docking',       sub: 'AutoDock Vina',      cumulative: 225 },
  { id: 'adme',      label: 'ADME/Tox',      sub: 'Lipinski + pkCSM',   cumulative: 260 },
]
const STEP_ICONS = ['🔬', '🧬', '🔗', '⚛️', '💊', '⚡', '🛡️']

const affinityColor = (v?: number) => {
  if (!v) return 'var(--dim-text)'
  if (v <= -10) return 'var(--mol-green)'
  if (v <= -8)  return '#00e0b0'
  if (v <= -6)  return 'var(--soft-blue)'
  return 'var(--hot-orange)'
}
const affinityPct = (v?: number) => {
  if (!v) return 0
  return Math.min(100, Math.max(0, ((-v - 3) / 9) * 100))
}
const fmtNum = (n?: number, d = 2) =>
  n !== undefined && n !== null ? n.toFixed(d) : '—'

function AtomLoader() {
  return (
    <div className="atom-loader">
      <div className="atom-nucleus" />
      <div className="atom-orbit atom-orbit-1"><div className="electron e-blue" /></div>
      <div className="atom-orbit atom-orbit-2"><div className="electron e-green" /></div>
      <div className="atom-orbit atom-orbit-3"><div className="electron e-soft" /></div>
    </div>
  )
}

function RadialScore({ pct, label, color = '#00c5ff', size = 72 }: {
  pct: number; label: string; color?: string; size?: number
}) {
  const r = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(26,42,74,0.8)" strokeWidth="5" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={circ / 4} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1.2s ease-out' }} />
        <text x={size/2} y={size/2 + 5} textAnchor="middle"
          style={{ fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 600, fill: color }}>
          {Math.round(pct)}%
        </text>
      </svg>
      <span style={{ fontFamily: 'JetBrains Mono', fontSize: 10, color: 'var(--mid-text)' }}>{label}</span>
    </div>
  )
}

export default function Page() {
  const [phase, setPhase]       = useState<'idle'|'running'|'done'|'error'>('idle')
  const [disease, setDisease]   = useState('')
  const [stepIdx, setStepIdx]   = useState(-1)
  const [elapsed, setElapsed]   = useState(0)
  const [report, setReport]     = useState<FinalReport | null>(null)
  const [rawOut, setRawOut]     = useState('')
  const [errMsg, setErrMsg]     = useState('')
  const [tab, setTab]           = useState('gene')
  const [expanded, setExpanded] = useState<number | null>(null)
  const timerRef                = useRef<ReturnType<typeof setInterval> | null>(null)
  const startRef                = useRef(0)

  useEffect(() => {
    if (phase === 'running') {
      startRef.current = Date.now()
      timerRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - startRef.current) / 1000)
        setElapsed(s)
        const idx = STEPS.findIndex(st => st.cumulative > s)
        setStepIdx(idx === -1 ? STEPS.length - 1 : idx)
      }, 500)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [phase])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!disease.trim()) return
    setPhase('running'); setStepIdx(0); setElapsed(0)
    setReport(null); setErrMsg(''); setTab('gene'); setExpanded(null)
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disease: disease.trim() }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setReport(data.final_report || data)
      setRawOut(data.output || '')
      setStepIdx(STEPS.length)
      setPhase('done')
    } catch (err: unknown) {
      setErrMsg(err instanceof Error ? err.message : 'Pipeline failed')
      setPhase('error')
    }
  }, [disease])

  const fmtTime = (s: number) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

  return (
    <main className="min-h-screen" style={{ background: 'var(--void)', backgroundImage: 'radial-gradient(circle, rgba(0,197,255,0.10) 1px, transparent 1px)', backgroundSize: '40px 40px' }}>

      {phase === 'idle' && (
        <section className="relative flex flex-col items-center justify-center min-h-screen px-6 py-20 overflow-hidden">
          <div style={{ position:'absolute', top:'15%', left:'10%', width:400, height:400, borderRadius:'50%', background:'radial-gradient(circle, rgba(0,197,255,0.06) 0%, transparent 70%)', pointerEvents:'none' }} />
          <div style={{ position:'absolute', bottom:'15%', right:'8%', width:500, height:500, borderRadius:'50%', background:'radial-gradient(circle, rgba(0,255,136,0.05) 0%, transparent 70%)', pointerEvents:'none' }} />

          <div className="fade-in d1 mb-8 flex items-center gap-2 px-4 py-2 rounded-full" style={{ background:'rgba(0,197,255,0.08)', border:'1px solid rgba(0,197,255,0.2)', fontFamily:'JetBrains Mono', fontSize:11, color:'var(--electric-blue)', letterSpacing:'0.1em' }}>
            <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--mol-green)', display:'inline-block', boxShadow:'0 0 8px var(--mol-green)' }} />
            IN-SILICO DRUG DISCOVERY PLATFORM · v2.0
          </div>

          <h1 className="fade-in d2 text-center font-bold leading-none mb-4" style={{ fontSize:'clamp(3rem,8vw,7rem)', letterSpacing:'-0.03em', color:'var(--bright-text)' }}>
            Disease <span className="gradient-text text-glow-blue">→</span> Drug
          </h1>
          <p className="fade-in d3 text-center mb-4 font-light" style={{ fontSize:'clamp(1.1rem,2.5vw,1.5rem)', color:'var(--mid-text)', maxWidth:620 }}>
            Enter a disease. The pipeline mines literature, ranks gene targets, models protein structure, screens ligands, and docks top candidates — automatically.
          </p>

          <div className="fade-in d4 flex flex-wrap justify-center gap-6 mb-12" style={{ fontSize:12, fontFamily:'JetBrains Mono', color:'var(--dim-text)' }}>
            {[['7','Pipeline Stages'],['40+','PubMed Papers'],['AlphaFold','3D Structures'],['AutoDock','Vina Docking'],['Lipinski','Rule of Five']].map(([v,l]) => (
              <span key={l} className="flex items-center gap-2">
                <span style={{ color:'var(--electric-blue)', fontWeight:600 }}>{v}</span><span>{l}</span>
              </span>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="fade-in d5 w-full max-w-2xl">
            <div className="relative">
              <input className="sci-input w-full rounded-xl px-6 py-5 pr-40 text-lg"
                placeholder="e.g. Parkinson’s disease, Alzheimer’s, Breast Cancer…"
                value={disease} onChange={e => setDisease(e.target.value)} autoFocus />
              <button type="submit" disabled={!disease.trim()}
                className="sci-btn absolute right-3 top-3 bottom-3 px-6 rounded-lg text-sm uppercase tracking-widest">
                Analyse →
              </button>
            </div>
            <p className="mt-3 text-center" style={{ fontFamily:'JetBrains Mono', fontSize:11, color:'var(--dim-text)' }}>
              Pipeline runs 3–5 minutes · Results include molecular docking, ADME, drug-likeness
            </p>
          </form>

          <div className="fade-in d6 mt-16 flex items-center gap-0 max-w-5xl w-full overflow-x-auto pb-2">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center flex-1 min-w-0">
                <div className="flex flex-col items-center gap-1 px-2" style={{ minWidth:80 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:'rgba(26,42,74,0.6)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>
                    {STEP_ICONS[i]}
                  </div>
                  <span style={{ fontFamily:'JetBrains Mono', fontSize:9, color:'var(--dim-text)', textAlign:'center', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <div style={{ flex:1, height:1, background:'var(--border)', minWidth:10 }} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {phase === 'running' && (
        <section className="flex flex-col items-center justify-center min-h-screen px-6 py-20">
          <AtomLoader />
          <div className="mt-8 text-center mb-2">
            <h2 className="font-bold text-2xl" style={{ color:'var(--bright-text)' }}>
              Analysing <span className="gradient-text">&ldquo;{disease}&rdquo;</span>
            </h2>
            <p className="mt-1" style={{ fontFamily:'JetBrains Mono', fontSize:13, color:'var(--dim-text)' }}>
              {stepIdx >= 0 && stepIdx < STEPS.length ? STEPS[stepIdx].sub : 'Initialising…'}
              {' · '}<span style={{ color:'var(--electric-blue)' }}>{fmtTime(elapsed)}</span> elapsed
            </p>
          </div>
          <div className="mt-10 w-full max-w-4xl glass-card rounded-2xl p-6">
            <div className="flex items-center gap-0">
              {STEPS.map((s, i) => {
                const done = i < stepIdx, active = i === stepIdx
                return (
                  <div key={s.id} className="flex items-center flex-1 min-w-0">
                    <div className="flex flex-col items-center gap-2" style={{ minWidth:72 }}>
                      <div style={{
                        width:44, height:44, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18,
                        background: done ? 'rgba(0,255,136,0.12)' : active ? 'rgba(0,197,255,0.12)' : 'rgba(26,42,74,0.5)',
                        border: `2px solid ${done ? 'var(--mol-green)' : active ? 'var(--electric-blue)' : 'var(--border)'}`,
                        boxShadow: active ? '0 0 20px rgba(0,197,255,0.5)' : done ? '0 0 12px rgba(0,255,136,0.3)' : 'none',
                        transition:'all 0.4s ease',
                      }}>{done ? '✓' : STEP_ICONS[i]}</div>
                      <span style={{ fontFamily:'JetBrains Mono', fontSize:9, textAlign:'center', whiteSpace:'nowrap', letterSpacing:'0.05em', color: done ? 'var(--mol-green)' : active ? 'var(--electric-blue)' : 'var(--dim-text)' }}>{s.label}</span>
                    </div>
                    {i < STEPS.length - 1 && <div className={`pipeline-connector${done ? ' done' : active ? ' active' : ''}`} />}
                  </div>
                )
              })}
            </div>
            <div className="mt-4 relative overflow-hidden rounded-full h-1" style={{ background:'var(--border)' }}>
              <div style={{ height:'100%', borderRadius:'100px', width:`${Math.min(100,(stepIdx/STEPS.length)*100)}%`, background:'linear-gradient(90deg,var(--electric-blue),var(--mol-green))', transition:'width 0.8s ease-out', boxShadow:'0 0 8px rgba(0,197,255,0.6)' }} />
            </div>
          </div>
          <p className="mt-6 text-center" style={{ fontFamily:'JetBrains Mono', fontSize:11, color:'var(--dim-text)' }}>Do not close this tab · Pipeline runs 3–5 minutes</p>
        </section>
      )}

      {phase === 'error' && (
        <section className="flex flex-col items-center justify-center min-h-screen px-6 py-20 gap-6">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-2xl font-bold" style={{ color:'var(--hot-orange)' }}>Pipeline Error</h2>
          <div className="glass-card rounded-xl px-6 py-4 max-w-lg w-full text-center">
            <p className="mono text-sm" style={{ color:'var(--hot-orange)' }}>{errMsg}</p>
          </div>
          <button className="sci-btn px-8 py-3 rounded-xl text-sm uppercase tracking-widest" onClick={() => setPhase('idle')}>← Try Again</button>
        </section>
      )}

      {phase === 'done' && report && (
        <section className="min-h-screen px-4 md:px-8 py-8 max-w-7xl mx-auto">
          <div className="fade-in d1 mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--mol-green)', display:'inline-block', boxShadow:'0 0 10px var(--mol-green)' }} />
                <span className="mono text-xs uppercase tracking-widest" style={{ color:'var(--mol-green)' }}>Pipeline Complete</span>
                <span className="mono text-xs" style={{ color:'var(--dim-text)' }}>{fmtTime(elapsed)}</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-bold" style={{ color:'var(--bright-text)', letterSpacing:'-0.02em' }}>{report.disease}</h1>
              <p className="mt-1 mono text-xs" style={{ color:'var(--dim-text)' }}>ID: {report.pipeline_id} · {new Date(report.timestamp).toLocaleString()}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {[
                { label:'Primary Target', value: report.gene?.primary || '—', color:'var(--electric-blue)' },
                { label:'Top Affinity', value: report.top_candidate?.affinity ? `${report.top_candidate.affinity} kcal/mol` : '—', color:'var(--mol-green)' },
                { label:'Binding Class', value: report.top_candidate?.class || '—', color:'var(--soft-blue)' },
                { label:'Drug-like', value: report.top_candidate?.drug_like ? 'Yes ✓' : 'No', color: report.top_candidate?.drug_like ? 'var(--mol-green)' : 'var(--hot-orange)' },
              ].map(s => (
                <div key={s.label} className="glass-card rounded-xl px-4 py-3 text-center min-w-[120px]">
                  <div className="mono text-xs mb-1" style={{ color:'var(--dim-text)', letterSpacing:'0.05em' }}>{s.label}</div>
                  <div className="mono font-semibold text-sm" style={{ color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="fade-in d2 flex gap-0 border-b mb-6" style={{ borderColor:'var(--border)' }}>
            {[{id:'gene',label:'🧬 Gene Target'},{id:'protein',label:'🔗 Protein Structure'},{id:'docking',label:'⚡ Drug Candidates'},{id:'adme',label:'🛡️ ADME Profile'}].map(t => (
              <button key={t.id} className={`sci-tab px-5 py-3 text-sm font-medium ${tab===t.id?'active':''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {tab === 'gene' && report.gene && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 fade-in">
              <div className="lg:col-span-1 glass-card-bright rounded-2xl p-6 flex flex-col items-center justify-center text-center relative overflow-hidden">
                <div className="scan-line" />
                <div className="mono text-xs uppercase tracking-widest mb-4" style={{ color:'var(--dim-text)' }}>Primary Target Gene</div>
                <div className="font-bold text-glow-blue gradient-text" style={{ fontSize:'3.5rem', letterSpacing:'-0.02em', lineHeight:1 }}>{report.gene.primary}</div>
                <div className="mt-3 px-3 py-1 rounded-full badge-info text-xs">Score: {fmtNum(report.gene.score, 1)}</div>
                <div className="mt-4 mono text-xs" style={{ color:'var(--dim-text)' }}>
                  {report.sequences?.protein_length ? `${report.sequences.protein_length} aa · ${(report.sequences.protein_mass||0).toLocaleString()} Da` : ''}
                </div>
              </div>
              <div className="lg:col-span-2 glass-card rounded-2xl p-6">
                <h3 className="font-semibold mb-4" style={{ color:'var(--bright-text)' }}>Ranked Gene Targets</h3>
                <div className="flex flex-col gap-3">
                  {(report.gene.ranked||[]).slice(0,8).map((g,i) => {
                    const maxScore = report.gene.ranked[0]?.total||1
                    const pct = (g.total/maxScore)*100
                    return (
                      <div key={g.symbol} className="flex items-center gap-3">
                        <div className={`rank-${i<3?i+1:'other'} flex items-center justify-center rounded-full mono font-bold`} style={{ width:28,height:28,fontSize:11,flexShrink:0 }}>{i+1}</div>
                        <span className="mono font-semibold" style={{ color:'var(--bright-text)',minWidth:70,fontSize:13 }}>{g.symbol}</span>
                        <div className="flex-1 relative h-5 rounded overflow-hidden" style={{ background:'rgba(26,42,74,0.6)' }}>
                          <div className="shimmer-bar absolute inset-0 rounded" style={{ width:`${pct}%`, background: i===0?'linear-gradient(90deg,var(--electric-blue),var(--mol-green))':'linear-gradient(90deg,rgba(0,197,255,0.5),rgba(0,197,255,0.2))', transition:'width 1s ease-out' }} />
                        </div>
                        <span className="mono text-xs" style={{ color:'var(--mid-text)',minWidth:40,textAlign:'right' }}>{fmtNum(g.total,1)}</span>
                        <span className="badge-neutral px-2 py-0.5 rounded text-xs">{g.source||'—'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'protein' && report.protein && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 fade-in">
              <div className="glass-card rounded-2xl p-6 flex flex-col gap-4">
                <h3 className="font-semibold" style={{ color:'var(--bright-text)' }}>Protein Information</h3>
                {[
                  { label:'UniProt ID', value:report.protein.uniprot_id, mono:true, link:`https://www.uniprot.org/uniprotkb/${report.protein.uniprot_id}` },
                  { label:'Name', value:report.protein.name, mono:false },
                  { label:'Length', value:`${report.protein.length||'—'} aa`, mono:true },
                  { label:'Location', value:report.protein.subcellular_location, mono:false },
                ].map(r => r.value && (
                  <div key={r.label} className="flex flex-col gap-0.5">
                    <span style={{ fontFamily:'JetBrains Mono',fontSize:10,color:'var(--dim-text)',letterSpacing:'0.1em',textTransform:'uppercase' }}>{r.label}</span>
                    {r.link
                      ? <a href={r.link} target="_blank" rel="noopener" className="font-medium text-sm flex items-center gap-1" style={{ color:'var(--electric-blue)',fontFamily:r.mono?'JetBrains Mono':undefined }}>{r.value} <span style={{fontSize:10}}>↗</span></a>
                      : <span className={r.mono?'mono':''} style={{ color:'var(--body-text)',fontSize:14 }}>{r.value}</span>
                    }
                  </div>
                ))}
                {report.protein.function && (
                  <div>
                    <span style={{ fontFamily:'JetBrains Mono',fontSize:10,color:'var(--dim-text)',letterSpacing:'0.1em',textTransform:'uppercase',display:'block',marginBottom:4 }}>Function</span>
                    <p style={{ fontSize:12,color:'var(--mid-text)',lineHeight:1.6 }}>{report.protein.function}</p>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-5">
                {report.tertiary_structure && (
                  <div className="glass-card rounded-2xl p-6">
                    <h3 className="font-semibold mb-4" style={{ color:'var(--bright-text)' }}>3D Structure Quality</h3>
                    <div className="flex items-center gap-6">
                      <RadialScore pct={report.tertiary_structure.plddt||0} label="pLDDT" color="var(--electric-blue)" size={80} />
                      <div className="flex flex-col gap-2 flex-1">
                        {[
                          { label:'Source', value:report.tertiary_structure.source },
                          { label:'Grade', value:report.tertiary_structure.grade, good:'AB'.includes(report.tertiary_structure.grade) },
                          { label:'Residues', value:`${report.tertiary_structure.residues||'—'} Cα atoms` },
                        ].map(r => (
                          <div key={r.label} className="flex justify-between items-center">
                            <span className="mono text-xs" style={{ color:'var(--dim-text)' }}>{r.label}</span>
                            <span className={`mono text-xs font-semibold ${'good' in r && r.good ? 'text-glow-green':''}`} style={{ color:'good' in r?(r.good?'var(--mol-green)':'var(--hot-orange)'):'var(--body-text)' }}>{r.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {report.secondary_structure && (
                  <div className="glass-card rounded-2xl p-6">
                    <h3 className="font-semibold mb-4" style={{ color:'var(--bright-text)' }}>Secondary Structure</h3>
                    <p className="mono text-xs mb-4" style={{ color:'var(--dim-text)' }}>Method: {report.secondary_structure.method}</p>
                    {[
                      { label:'α-Helix', pct:report.secondary_structure.alpha_helix_pct, color:'var(--electric-blue)' },
                      { label:'β-Sheet', pct:report.secondary_structure.beta_sheet_pct, color:'var(--mol-green)' },
                      { label:'Random Coil', pct:report.secondary_structure.coil_pct, color:'var(--dim-text)' },
                    ].map(b => (
                      <div key={b.label} className="flex items-center gap-3 mb-3">
                        <span className="mono text-xs" style={{ color:'var(--mid-text)',minWidth:80 }}>{b.label}</span>
                        <div className="flex-1 relative h-6 rounded overflow-hidden" style={{ background:'rgba(26,42,74,0.6)' }}>
                          <div style={{ position:'absolute',inset:0,width:`${b.pct}%`,background:b.color,opacity:0.8,borderRadius:4,transition:'width 1.2s cubic-bezier(0.34,1.56,0.64,1)',display:'flex',alignItems:'center',paddingLeft:8 }}>
                            {b.pct>10 && <span style={{ fontFamily:'JetBrains Mono',fontSize:10,fontWeight:600,color:'#000',opacity:0.8 }}>{b.pct}%</span>}
                          </div>
                          {b.pct<=10 && <span className="absolute right-2 top-1/2 -translate-y-1/2" style={{ fontFamily:'JetBrains Mono',fontSize:10,color:'var(--mid-text)' }}>{b.pct}%</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'docking' && report.docking_results && (
            <div className="flex flex-col gap-5 fade-in">
              {report.top_candidate && (
                <div className="glass-card-bright rounded-2xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="md:col-span-2">
                    <div className="mono text-xs uppercase tracking-widest mb-2" style={{ color:'var(--mol-green)' }}>🏆 Top Drug Candidate</div>
                    <h2 className="text-2xl font-bold mb-1" style={{ color:'var(--bright-text)' }}>{report.top_candidate.name}</h2>
                    <p className="mono text-xs mb-4" style={{ color:'var(--dim-text)',wordBreak:'break-all' }}>{report.top_candidate.smiles?.substring(0,60)}{(report.top_candidate.smiles?.length||0)>60?'…':''}</p>
                    <div className="flex flex-wrap gap-2">
                      <span className="badge-good px-3 py-1 rounded-full text-xs">{report.top_candidate.affinity} kcal/mol</span>
                      <span className="badge-info px-3 py-1 rounded-full text-xs">{report.top_candidate.class}</span>
                      <span className={`px-3 py-1 rounded-full text-xs ${report.top_candidate.drug_like?'badge-good':'badge-warn'}`}>{report.top_candidate.drug_like?'✓ Drug-like':'✗ Not drug-like'}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-center">
                    <RadialScore pct={Math.min(100,report.top_candidate.score||0)} label="Score" color="var(--mol-green)" size={100} />
                  </div>
                </div>
              )}
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="p-4 border-b flex items-center justify-between" style={{ borderColor:'var(--border)' }}>
                  <h3 className="font-semibold" style={{ color:'var(--bright-text)' }}>All Candidates</h3>
                  <span className="badge-info px-3 py-1 rounded-full text-xs">{report.docking_results.length} compounds</span>
                </div>
                {report.docking_results.map((c,i) => (
                  <div key={i} className="border-b" style={{ borderColor:'var(--border)' }}>
                    <div className="flex items-center gap-4 p-4 cursor-pointer hover:bg-white/[0.02] transition-colors" onClick={() => setExpanded(expanded===i?null:i)}>
                      <div className={`rank-${i<3?i+1:'other'} flex items-center justify-center rounded-full mono font-bold flex-shrink-0`} style={{ width:32,height:32,fontSize:12 }}>{c.rank||i+1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm mb-0.5 truncate" style={{ color:'var(--bright-text)' }}>{c.name}</div>
                        <div className="mono text-xs truncate" style={{ color:'var(--dim-text)' }}>{c.smiles?.substring(0,50)}{(c.smiles?.length||0)>50?'…':''}</div>
                      </div>
                      <div className="hidden md:flex flex-col gap-1 w-36">
                        <div className="flex justify-between mono text-xs" style={{ color:'var(--dim-text)' }}>
                          <span>Affinity</span><span style={{ color:affinityColor(c.affinity_kcal_mol) }}>{c.affinity_kcal_mol} kcal/mol</span>
                        </div>
                        <div className="relative h-2 rounded-full overflow-hidden" style={{ background:'rgba(26,42,74,0.8)' }}>
                          <div style={{ width:`${affinityPct(c.affinity_kcal_mol)}%`,height:'100%',background:`linear-gradient(90deg,var(--electric-blue),${affinityColor(c.affinity_kcal_mol)})`,borderRadius:'100px',transition:'width 1s ease-out' }} />
                        </div>
                      </div>
                      <div className="hidden lg:flex flex-col gap-1 items-end">
                        <span className={`px-2 py-0.5 rounded text-xs ${c.adme?.lipinski?.drug_like?'badge-good':'badge-warn'}`}>{c.adme?.lipinski?.drug_like?'✓ Drug-like':'✗ Not drug-like'}</span>
                        <span className="badge-neutral px-2 py-0.5 rounded text-xs">{c.class||'—'}</span>
                      </div>
                      <span style={{ color:'var(--dim-text)',fontSize:18,transform:expanded===i?'rotate(90deg)':'none',transition:'transform 0.2s' }}>›</span>
                    </div>
                    {expanded===i && c.adme && (
                      <div className="px-4 pb-5 pt-0" style={{ background:'rgba(0,0,0,0.2)' }}>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                          {[
                            { label:'MW', value:`${c.adme.lipinski.mw||'—'} Da`, ok:(c.adme.lipinski.mw||999)<=500 },
                            { label:'LogP', value:fmtNum(c.adme.lipinski.logp), ok:(c.adme.lipinski.logp||0)<=5 },
                            { label:'H-Bond D', value:String(c.adme.lipinski.hbd??'—'), ok:(c.adme.lipinski.hbd||0)<=5 },
                            { label:'H-Bond A', value:String(c.adme.lipinski.hba??'—'), ok:(c.adme.lipinski.hba||0)<=10 },
                            { label:'Rot. Bond', value:String(c.adme.lipinski.rotb??'—'), ok:(c.adme.lipinski.rotb||0)<=10 },
                            { label:'TPSA', value:`${fmtNum(c.adme.lipinski.tpsa)} Å²`, ok:(c.adme.lipinski.tpsa||999)<=140 },
                            { label:'GI Absorp.', value:c.adme.absorption.gi_absorption||'—', ok:c.adme.absorption.gi_absorption==='High' },
                            { label:'BBB', value:c.adme.absorption.bbb_penetrant?'Yes':'No', ok:false },
                          ].map(r => (
                            <div key={r.label} className={`rounded-xl p-3 ${r.ok?'badge-good':'badge-warn'}`} style={{ borderRadius:10 }}>
                              <div style={{ fontFamily:'JetBrains Mono',fontSize:9,letterSpacing:'0.1em',opacity:0.7,marginBottom:2 }}>{r.label}</div>
                              <div style={{ fontFamily:'JetBrains Mono',fontSize:13,fontWeight:600 }}>{r.value}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <span className="mono text-xs" style={{ color:'var(--dim-text)' }}>Lipinski Violations:</span>
                          <span className={`mono text-xs font-bold ${c.adme.lipinski.violations===0?'text-glow-green':''}`} style={{ color:c.adme.lipinski.violations===0?'var(--mol-green)':'var(--hot-orange)' }}>{c.adme.lipinski.violations}/4</span>
                          <span className="mono text-xs" style={{ color:'var(--dim-text)' }}>· Source: {c.source}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'adme' && report.docking_results && (
            <div className="flex flex-col gap-5 fade-in">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {report.docking_results.slice(0,5).map((c,i) => {
                  const lip=c.adme?.lipinski,abs=c.adme?.absorption,met=c.adme?.metabolism,exc=c.adme?.excretion
                  if(!lip) return null
                  return (
                    <div key={i} className="glass-card rounded-2xl p-5">
                      <div className="flex items-center gap-3 mb-4">
                        <div className={`rank-${i<3?i+1:'other'} flex items-center justify-center rounded-full mono font-bold flex-shrink-0`} style={{ width:28,height:28,fontSize:11 }}>{c.rank||i+1}</div>
                        <div>
                          <div className="font-semibold text-sm" style={{ color:'var(--bright-text)' }}>{c.name}</div>
                          <div className="mono text-xs" style={{ color:'var(--dim-text)' }}>{c.affinity_kcal_mol} kcal/mol · {c.class}</div>
                        </div>
                      </div>
                      <div className="mb-3">
                        <div className="mono text-xs uppercase tracking-widest mb-2" style={{ color:'var(--dim-text)' }}>Lipinski Ro5</div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {[
                            { k:'MW',v:`${lip.mw||'—'}`,ok:(lip.mw||0)<=500 },
                            { k:'LogP',v:fmtNum(lip.logp),ok:lip.logp<=5 },
                            { k:'HBD',v:String(lip.hbd??'—'),ok:(lip.hbd||0)<=5 },
                            { k:'HBA',v:String(lip.hba??'—'),ok:(lip.hba||0)<=10 },
                            { k:'RotB',v:String(lip.rotb??'—'),ok:(lip.rotb||0)<=10 },
                            { k:'TPSA',v:`${fmtNum(lip.tpsa,0)}`,ok:(lip.tpsa||0)<=140 },
                          ].map(r => (
                            <div key={r.k} className={`p-1.5 rounded text-center ${r.ok?'badge-good':'badge-warn'}`}>
                              <div style={{ fontFamily:'JetBrains Mono',fontSize:8,opacity:0.65 }}>{r.k}</div>
                              <div style={{ fontFamily:'JetBrains Mono',fontSize:11,fontWeight:600 }}>{r.v}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="mono text-xs" style={{ color:'var(--dim-text)' }}>Violations: <span style={{ color:lip.violations===0?'var(--mol-green)':'var(--hot-orange)',fontWeight:600 }}>{lip.violations}/4</span></span>
                          <span className={`px-2 py-0.5 rounded text-xs ${lip.drug_like?'badge-good':'badge-warn'}`}>{lip.drug_like?'✓ Drug-like':'✗ Fails'}</span>
                        </div>
                      </div>
                      <div className="mono text-xs uppercase tracking-widest mb-2" style={{ color:'var(--dim-text)' }}>ADME</div>
                      <div className="flex flex-wrap gap-1.5">
                        {abs && <span className={`px-2 py-0.5 rounded text-xs ${abs.gi_absorption==='High'?'badge-good':'badge-warn'}`}>GI: {abs.gi_absorption||'—'}</span>}
                        {abs && <span className="px-2 py-0.5 rounded text-xs badge-neutral">BBB: {abs.bbb_penetrant?'Yes':'No'}</span>}
                        {met && <span className={`px-2 py-0.5 rounded text-xs ${met.cyp_inhibition_risk==='Low'?'badge-good':'badge-warn'}`}>CYP: {met.cyp_inhibition_risk||'—'}</span>}
                        {exc && <span className="badge-info px-2 py-0.5 rounded text-xs">{exc.solubility_class||'—'}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="glass-card rounded-2xl p-6">
                <h3 className="font-semibold mb-5" style={{ color:'var(--bright-text)' }}>Binding Affinity Comparison</h3>
                <div className="flex flex-col gap-3">
                  {report.docking_results.slice(0,5).map((c,i) => {
                    const pct=affinityPct(c.affinity_kcal_mol),col=affinityColor(c.affinity_kcal_mol)
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <span className="mono text-xs" style={{ color:'var(--mid-text)',minWidth:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{c.name}</span>
                        <div className="flex-1 relative h-6 rounded-full overflow-hidden" style={{ background:'rgba(26,42,74,0.6)' }}>
                          <div style={{ width:`${pct}%`,height:'100%',background:`linear-gradient(90deg,rgba(0,197,255,0.6),${col})`,borderRadius:'100px',transition:'width 1s ease-out' }} />
                        </div>
                        <span className="mono text-xs font-semibold" style={{ color:col,minWidth:80,textAlign:'right' }}>{c.affinity_kcal_mol} kcal/mol</span>
                        <span className="badge-neutral px-2 py-0.5 rounded text-xs hidden sm:inline">{c.class}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-4 flex flex-wrap gap-4 mono text-xs" style={{ color:'var(--dim-text)' }}>
                  {[['Very Strong','> -10','var(--mol-green)'],['Strong','> -8','#00e0b0'],['Moderate','> -6','var(--soft-blue)'],['Weak','< -6','var(--hot-orange)']].map(([k,v,c]) => (
                    <span key={k} className="flex items-center gap-1.5">
                      <span style={{ width:8,height:8,borderRadius:'50%',background:c,display:'inline-block' }} />{k} ({v} kcal/mol)
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="fade-in mt-8 flex flex-wrap gap-3 justify-end">
            <button className="sci-btn px-5 py-2.5 rounded-xl text-xs uppercase tracking-widest" onClick={() => { setPhase('idle'); setReport(null); setDisease('') }}>← New Analysis</button>
            {rawOut && (
              <button className="sci-btn px-5 py-2.5 rounded-xl text-xs uppercase tracking-widest"
                onClick={() => { const b=new Blob([rawOut],{type:'text/markdown'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download=`${report.disease?.replace(/\s+/g,'_')}_report.md`; a.click() }}>
                ↓ Download Report
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  )
}
