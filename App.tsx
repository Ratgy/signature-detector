
import { useEffect, useMemo, useRef, useState } from 'react'
import { findConfirmCandidate, scoreFastText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadPdf, preprocessCanvas, renderFast, renderPrecise, renderPreview, ROTATIONS } from './pdf'
import type { FileResult, Rotation } from './types'

const makeId=()=>Math.random().toString(36).slice(2)
const emptyResult=(file:File):FileResult=>({
  id:makeId(),fileName:file.name,status:'queued',progress:0,message:'대기 중',pageCount:0,pageIndex:null,
  rotation:0,confidence:0,fullPreview:null,cropPreview:null,anchorText:null,elapsedMs:0
})

export default function App(){
  const [files,setFiles]=useState<File[]>([])
  const [results,setResults]=useState<FileResult[]>([])
  const [processing,setProcessing]=useState(false)
  const inputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>()=>{terminateOCR()},[])

  // Keep every active file visibly moving while a long OCR call is running.
  // Real stage updates may jump forward; this timer fills the gaps 1% at a time.
  useEffect(()=>{
    if(!processing)return
    const id=window.setInterval(()=>{
      setResults(prev=>prev.map(r=>
        r.status==='processing' && r.progress<96 ? {...r,progress:r.progress+1} : r
      ))
    },140)
    return()=>window.clearInterval(id)
  },[processing])

  const update=(index:number,patch:Partial<FileResult>)=>{
    setResults(prev=>prev.map((r,i)=>i===index?{...r,...patch}:r))
  }

  async function processOne(file:File,index:number){
    const started=performance.now()
    update(index,{status:'processing',message:'PDF 여는 중',progress:1})
    const pdf=await loadPdf(file)
    update(index,{pageCount:pdf.numPages,message:'“확인합니다” 위치 탐색 중',progress:5})

    let best:{pageIndex:number;rotation:Rotation;score:number}|null=null

    for(let p=0;p<pdf.numPages;p++){
      const page=await pdf.getPage(p+1)
      const c=preprocessCanvas(await renderFast(page,0))
      const r=await recognizeTextFast(c)
      const s=scoreFastText(r.text).score+r.confidence*.05
      if(!best||s>best.score)best={pageIndex:p,rotation:0,score:s}
      update(index,{progress:8+Math.round(((p+1)/pdf.numPages)*35),message:`${p+1}/${pdf.numPages} 페이지 탐색`})
    }

    if(!best)throw new Error('후보를 찾지 못했습니다.')

    if(best.score<120){
      const page=await pdf.getPage(best.pageIndex+1)
      for(let i=1;i<ROTATIONS.length;i++){
        const rotation=ROTATIONS[i]
        const c=preprocessCanvas(await renderFast(page,rotation))
        const r=await recognizeTextFast(c)
        const s=scoreFastText(r.text).score+r.confidence*.05
        if(s>best.score)best={...best,rotation,score:s}
        update(index,{progress:45+i*5,message:`방향 확인 ${rotation}°`})
        if(best.score>=120)break
      }
    }

    update(index,{progress:64,message:'앵커 정밀 확인 중'})
    const page=await pdf.getPage(best.pageIndex+1)
    const precise=preprocessCanvas(await renderPrecise(page,best.rotation))
    const tokens=await recognizeWordsPrecise(precise,best.pageIndex,(p,s)=>{
      update(index,{progress:64+Math.round(p*24),message:`정밀 OCR · ${s}`})
    })
    const candidate=findConfirmCandidate(tokens,best.rotation)
    const fullPreview=await renderPreview(page)

    if(!candidate){
      update(index,{
        status:'failed',progress:100,message:'“확인합니다” 앵커 탐지 실패',
        pageIndex:best.pageIndex,rotation:best.rotation,fullPreview,elapsedMs:performance.now()-started
      })
      return
    }

    let rotatedCrop=candidate.cropRect
    if(best.rotation!==0){
      const anchor=tokens
        .map(t=>({t,score:t.text.replace(/\s/g,'').includes('확인합니다')?2:0}))
        .sort((a,b)=>b.score-a.score)[0]?.t
      if(anchor){
        const a=anchor.rect
        rotatedCrop={
          x:Math.max(0,a.x-.28),y:Math.max(0,a.y-.075),
          width:Math.min(.92,Math.max(.62,a.width+.56)),
          height:Math.min(.30,Math.max(.16,a.height+.19))
        }
      }
    }
    const cropPreview=cropCanvas(precise,rotatedCrop).toDataURL('image/jpeg',.94)

    update(index,{
      status:'success',progress:100,message:'탐지 완료',
      pageIndex:candidate.pageIndex,rotation:candidate.rotation,confidence:candidate.confidence,
      anchorText:candidate.anchorText,fullPreview,cropPreview,elapsedMs:performance.now()-started
    })
  }

  async function start(){
    if(!files.length||processing)return
    setProcessing(true)
    setResults(files.map(emptyResult))
    for(let i=0;i<files.length;i++){
      try{await processOne(files[i],i)}
      catch(e){update(i,{status:'failed',progress:100,message:`오류: ${e instanceof Error?e.message:String(e)}`})}
    }
    setProcessing(false)
  }

  function selectFiles(list:FileList|null){
    if(!list)return
    const arr=Array.from(list).filter(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf')).slice(0,5)
    setFiles(arr);setResults([])
  }

  function judge(index:number,j:FileResult['judgement']){ update(index,{judgement:j}) }

  const stats=useMemo(()=>{
    const judged=results.filter(r=>r.judgement)
    const correct=judged.filter(r=>r.judgement==='correct').length
    const partial=judged.filter(r=>r.judgement==='partial').length
    const total=judged.length
    return{total,correct,partial,exact:total?Math.round(correct/total*100):0,usable:total?Math.round((correct+partial)/total*100):0}
  },[results])

  return <div className="app">
    <header><div>
      <p className="eyebrow">BATCH ACCURACY TEST · “확인합니다” ANCHOR</p>
      <h1>서명란 탐지 검수 v6</h1>
      <p className="sub">최대 5개의 PDF를 한 번에 넣고 탐지된 서명란 확대 이미지만 빠르게 비교합니다.</p>
    </div></header>

    <section className={`dropzone ${processing?'disabled':''}`} onClick={()=>!processing&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" multiple accept="application/pdf,.pdf" hidden onChange={e=>selectFiles(e.target.files)}/>
      <div className="uploadIcon">5 PDF</div>
      <strong>{files.length?`${files.length}개 PDF 선택됨`:'PDF 최대 5개 선택'}</strong>
      <span>‘확인합니다’를 기준으로 서명/확인 블록을 탐지합니다.</span>
    </section>

    {files.length>0&&<section className="batchList">
      {files.map((f,i)=><div className="fileChip" key={f.name+i}><b>{i+1}</b><span>{f.name}</span></div>)}
      <button className="startBtn" disabled={processing} onClick={start}>{processing?'분석 중…':'선택한 파일 분석 시작'}</button>
    </section>}

    {results.map((r,i)=><section className="resultCard card" key={r.id}>
      <div className="resultTop">
        <div><p className="label">FILE {i+1}</p><h2>{r.fileName}</h2></div>
        <span className={`stateBadge ${r.status}`}>{r.status==='success'?`${Math.round(r.confidence*100)}%`:r.status}</span>
      </div>

      <div className="statusTop"><strong>{r.message}</strong><span className="bigPercent">{r.progress}%</span></div>
      <div className="progress"><i style={{width:`${r.progress}%`}}/></div>

      {r.cropPreview&&<>
        <div className="focusTitle">
          <div><p className="label">ENLARGED TARGET</p><h3>탐지된 서명란 확대</h3></div>
          <span>{r.pageIndex!==null?`${r.pageIndex+1}/${r.pageCount} 페이지`:''}</span>
        </div>
        <div className="largeCrop"><img src={r.cropPreview} alt="탐지된 서명란 확대"/></div>
        <div className="metaRow">
          <span>앵커 <b>{r.anchorText}</b></span><span>방향 <b>{r.rotation}°</b></span><span>시간 <b>{(r.elapsedMs/1000).toFixed(1)}s</b></span>
        </div>
      </>}

      {r.fullPreview&&<details className="fullDetails">
        <summary>전체 페이지 확인</summary>
        <div className="pagePreview"><img src={r.fullPreview} alt="전체 페이지"/></div>
      </details>}

      {(r.status==='success'||r.status==='failed')&&<div className="judgeButtons">
        <button className={r.judgement==='correct'?'selected':''} onClick={()=>judge(i,'correct')}>정확함</button>
        <button className={r.judgement==='partial'?'selected':''} onClick={()=>judge(i,'partial')}>일부 포함</button>
        <button className={r.judgement==='wrong'?'selected':''} onClick={()=>judge(i,'wrong')}>틀림</button>
        <button className={r.judgement==='failed'?'selected':''} onClick={()=>judge(i,'failed')}>탐지 실패</button>
      </div>}
    </section>)}

    {results.length>0&&<section className="stats">
      <div><span>평가</span><strong>{stats.total}</strong></div>
      <div><span>정확</span><strong>{stats.correct}</strong></div>
      <div><span>일부 포함</span><strong>{stats.partial}</strong></div>
      <div><span>Exact</span><strong>{stats.exact}%</strong></div>
      <div><span>Usable</span><strong>{stats.usable}%</strong></div>
    </section>}
  </div>
}
