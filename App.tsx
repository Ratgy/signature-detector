import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSignatureCandidates, scoreFastText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { loadPdf, preprocessCanvas, renderPageFast, renderPagePrecise, renderPagePreview, ROTATIONS } from './pdf'
import type { PageAnalysis, SavedResult, SignatureCandidate, TestJudgement } from './types'

const STORAGE_KEY='signature-detector-results-v2'
const pct=(n:number)=>`${Math.round(n*100)}%`
const loadSaved=():SavedResult[]=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)??'[]')}catch{return[]}}

export default function App(){
  const [file,setFile]=useState<File|null>(null)
  const [status,setStatus]=useState('PDF를 올려주세요')
  const [progress,setProgress]=useState(0)
  const [analyses,setAnalyses]=useState<PageAnalysis[]>([])
  const [candidateIndex,setCandidateIndex]=useState(0)
  const [debug,setDebug]=useState(false)
  const [processing,setProcessing]=useState(false)
  const [saved,setSaved]=useState<SavedResult[]>(loadSaved())
  const [timing,setTiming]=useState<{fast:number,precise:number,total:number}|null>(null)
  const inputRef=useRef<HTMLInputElement>(null)

  const candidates=useMemo(()=>analyses.flatMap(a=>a.candidates).sort((a,b)=>b.score-a.score).slice(0,3),[analyses])
  const candidate=candidates[candidateIndex]??null
  const activePage=candidate?analyses.find(a=>a.pageIndex===candidate.pageIndex):analyses[0]
  useEffect(()=>()=>{terminateOCR()},[])

  async function analyzePdf(selected:File){
    setFile(selected);setProcessing(true);setAnalyses([]);setCandidateIndex(0);setProgress(0);setTiming(null)
    const totalStarted=performance.now()
    try{
      const pdf=await loadPdf(selected)
      setStatus('문서 방향과 서명 페이지를 빠르게 찾는 중…')
      const fastStarted=performance.now()
      let best:{pageIndex:number;rotation:any;score:number;hits:string[]}|null=null

      // PASS 1: low-res text-only. Avoid expensive word boxes for every page/rotation.
      for(let p=1;p<=pdf.numPages;p++){
        const page=await pdf.getPage(p)
        for(let r=0;r<ROTATIONS.length;r++){
          const rotation=ROTATIONS[r]
          setStatus(`${p}/${pdf.numPages} 페이지 방향 확인 · ${rotation}°`)
          const small=preprocessCanvas(await renderPageFast(page,rotation))
          const result=await recognizeTextFast(small)
          const scored=scoreFastText(result.text)
          const combined=scored.score + result.confidence*.12
          if(!best || combined>best.score) best={pageIndex:p-1,rotation,score:combined,hits:scored.hits}
          // Signature anchors found strongly: no need to OCR other rotations of this page.
          if(scored.score>=90) break
        }
        setProgress((p/pdf.numPages)*.58)
      }
      const fastMs=performance.now()-fastStarted
      if(!best) throw new Error('문서 방향을 판단하지 못했습니다.')

      // PASS 2: only once, on the selected page + orientation.
      setStatus(`${best.pageIndex+1}페이지 ${best.rotation}° 정밀 OCR 중…`)
      const preciseStarted=performance.now()
      const page=await pdf.getPage(best.pageIndex+1)
      const preciseCanvas=preprocessCanvas(await renderPagePrecise(page,best.rotation))
      const tokens=await recognizeWordsPrecise(preciseCanvas,best.pageIndex,(v,s)=>{
        setProgress(.58+v*.40);setStatus(`서명 영역 정밀 탐지 · ${s}`)
      })
      const pageCandidates=detectSignatureCandidates(tokens,best.rotation)
      const previewDataUrl=await renderPagePreview(page,0)
      const analysis:PageAnalysis={
        pageIndex:best.pageIndex,width:preciseCanvas.width,height:preciseCanvas.height,
        rotation:best.rotation,tokens,candidates:pageCandidates,previewDataUrl,
        ocrDataUrl:preciseCanvas.toDataURL('image/jpeg',.84),elapsedMs:performance.now()-preciseStarted,
      }
      setAnalyses([analysis]);setProgress(1)
      const preciseMs=performance.now()-preciseStarted
      setTiming({fast:fastMs,precise:preciseMs,total:performance.now()-totalStarted})
      if(!pageCandidates.length) setStatus('년·월·일 + 서명/인 영역을 찾지 못했어요')
      else setStatus(`서명 영역을 찾았어요 · ${best.rotation}° 방향`)
    }catch(e){
      console.error(e);setStatus(`오류: ${e instanceof Error?e.message:String(e)}`)
    }finally{setProcessing(false)}
  }

  function judge(j:TestJudgement){
    if(!file)return
    const list=loadSaved()
    list.push({fileName:file.name,timestamp:Date.now(),score:candidate?.score??0,confidence:candidate?.confidence??0,pageIndex:candidate?.pageIndex??null,judgement:j})
    localStorage.setItem(STORAGE_KEY,JSON.stringify(list));setSaved(loadSaved())
  }
  const stats=useMemo(()=>{
    const total=saved.length,c=(v:TestJudgement)=>saved.filter(s=>s.judgement===v).length
    const correct=c('correct'),partial=c('partial')
    return{total,correct,partial,exact:total?correct/total:0,usable:total?(correct+partial)/total:0}
  },[saved])

  return <div className="app">
    <header><div><p className="eyebrow">FAST TWO-PASS OCR · MOBILE WEB</p><h1>서명영역 탐지 v2</h1><p className="sub">저해상도로 방향/페이지를 먼저 찾고, 선택된 1페이지만 정밀 OCR합니다.</p></div>
      <button className="ghost" onClick={()=>setDebug(v=>!v)}>{debug?'DEV 끄기':'DEV'}</button></header>

    <section className={`dropzone ${processing?'disabled':''}`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files?.[0];if(f)analyzePdf(f)}} onClick={()=>!processing&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)analyzePdf(f)}}/>
      <div className="uploadIcon">PDF</div><strong>{file?file.name:'성능점검기록부 PDF 업로드'}</strong>
      <span>{processing?'빠른 탐지 중입니다.':'휴대폰에서 PDF를 선택하세요.'}</span>
    </section>

    {(processing||file)&&<section className="statusCard"><div className="statusTop"><strong>{status}</strong><span>{Math.round(progress*100)}%</span></div>
      <div className="progress"><i style={{width:`${progress*100}%`}}/></div>
      <small>1차: 방향/페이지 탐색 → 2차: 선택 페이지만 정밀 OCR</small>
      {timing&&<div className="timing">방향 탐색 {(timing.fast/1000).toFixed(1)}s · 정밀 OCR {(timing.precise/1000).toFixed(1)}s · 총 {(timing.total/1000).toFixed(1)}s</div>}
    </section>}

    {!processing&&file&&analyses.length>0&&<><section className="resultGrid">
      <article className="card cropCard"><div className="cardHead"><div><p className="label">TARGET AREA ONLY</p><h2>{candidate?`후보 ${candidateIndex+1} · ${pct(candidate.confidence)}`:'탐지 실패'}</h2></div>
        {candidate&&<span className="confidence high">{candidate.rotation}°</span>}</div>
        {candidate&&activePage?<><CropPreview imageUrl={activePage.ocrDataUrl} rect={candidate.rotatedRect}/><div className="chips">{candidate.matchedKeywords.map(k=><span key={k}>{k}</span>)}</div>
        <div className="candidateNav"><button disabled={candidateIndex===0} onClick={()=>setCandidateIndex(i=>Math.max(0,i-1))}>이전</button><b>{candidateIndex+1} / {candidates.length}</b><button disabled={candidateIndex>=candidates.length-1} onClick={()=>setCandidateIndex(i=>Math.min(candidates.length-1,i+1))}>다음</button></div></>
        :<div className="emptyResult">‘년·월·일’과 ‘서명/인/매수인’이 함께 있는 영역만 후보로 인정합니다.</div>}
      </article>
      <article className="card fullCard"><div className="cardHead"><div><p className="label">FULL PAGE</p><h2>전체 문서에서 보기</h2></div>{candidate&&<span className="pageBadge">{candidate.pageIndex+1}페이지</span>}</div>
        {activePage&&<FullPagePreview imageUrl={activePage.previewDataUrl} rect={candidate?.rect??null}/>}</article>
    </section>

    <section className="judgeCard"><div><strong>탐지 결과는 어땠나요?</strong><span>정확/일부 포함만 빠르게 기록해 주세요.</span></div><div className="judgeButtons">
      <button onClick={()=>judge('correct')}>정확함</button><button onClick={()=>judge('partial')}>일부 포함</button><button onClick={()=>judge('wrong')}>틀림</button><button onClick={()=>judge('failed')}>탐지 실패</button></div></section>

    {debug&&<section className="debugGrid"><article className="card"><p className="label">DETECTION DEBUG</p><pre>{JSON.stringify(candidate?{page:candidate.pageIndex+1,rotation:candidate.rotation,score:candidate.score,confidence:candidate.confidence,matchedKeywords:candidate.matchedKeywords,rect:candidate.rect,breakdown:candidate.breakdown}:null,null,2)}</pre></article>
      <article className="card"><p className="label">OCR TOKENS</p><div className="tokenList">{(activePage?.tokens??[]).slice(0,160).map((t,i)=><span key={i}>{t.text} <em>{Math.round(t.confidence)}</em></span>)}</div></article></section>}
    <section className="stats"><div><span>테스트</span><strong>{stats.total}</strong></div><div><span>정확</span><strong>{stats.correct}</strong></div><div><span>일부 포함</span><strong>{stats.partial}</strong></div><div><span>Exact</span><strong>{pct(stats.exact)}</strong></div><div><span>Usable</span><strong>{pct(stats.usable)}</strong></div></section></>}
  </div>
}
function CropPreview({imageUrl,rect}:{imageUrl:string,rect:{x:number,y:number,width:number,height:number}}){
  const aspect=Math.max(.45,Math.min(3.2,rect.width/rect.height))
  return <div className="cropViewport" style={{aspectRatio:`${aspect}`}}><img src={imageUrl} alt="탐지 영역" style={{width:`${100/rect.width}%`,height:`${100/rect.height}%`,left:`${-(rect.x/rect.width)*100}%`,top:`${-(rect.y/rect.height)*100}%`}}/></div>
}
function FullPagePreview({imageUrl,rect}:{imageUrl:string,rect:{x:number,y:number,width:number,height:number}|null}){
  return <div className="pagePreview"><img src={imageUrl} alt="PDF 페이지"/>{rect&&<div className="detectedRect" style={{left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`}}><span>서명 후보</span></div>}</div>
}
