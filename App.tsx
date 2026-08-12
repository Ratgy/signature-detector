import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSigningBlocks, scoreFastPageText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadSource, preprocessCanvas, renderSourcePage } from './source'
import type { FileResult } from './types'

const makeId=()=>Math.random().toString(36).slice(2)
const emptyResult=(file:File):FileResult=>({
  id:makeId(),
  fileName:file.name,
  fileType:file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')?'pdf':'image',
  status:'queued',
  progress:0,
  message:'대기 중',
  pageCount:0,
  pageIndex:null,
  confidence:0,
  fullPreview:null,
  cropPreview:null,
  elapsedMs:0,
  matched:null
})

export default function App(){
  const [files,setFiles]=useState<File[]>([])
  const [results,setResults]=useState<FileResult[]>([])
  const [processing,setProcessing]=useState(false)
  const inputRef=useRef<HTMLInputElement>(null)
  const progressTimers=useRef<Record<number,number>>({})

  useEffect(()=>()=>{terminateOCR()},[])

  const update=(index:number,patch:Partial<FileResult>)=>{
    setResults(prev=>prev.map((r,i)=>i===index?{...r,...patch}:r))
  }

  const startSmoothProgress=(index:number)=>{
    stopSmoothProgress(index)
    progressTimers.current[index]=window.setInterval(()=>{
      setResults(prev=>prev.map((r,i)=>{
        if(i!==index||r.status!=='processing')return r
        const max = r.progress<35 ? 35 : r.progress<60 ? 60 : r.progress<88 ? 88 : 96
        return r.progress<max ? {...r,progress:r.progress+1} : r
      }))
    },120)
  }
  const stopSmoothProgress=(index:number)=>{
    const id=progressTimers.current[index]
    if(id){clearInterval(id);delete progressTimers.current[index]}
  }

  async function processOne(file:File,index:number){
    const started=performance.now()
    update(index,{status:'processing',progress:1,message:'파일 여는 중'})
    startSmoothProgress(index)

    const src=await loadSource(file)
    update(index,{pageCount:src.pageCount,progress:6,message:'서명 문맥이 있는 페이지 찾는 중'})

    let best:{pageIndex:number;score:number}|null=null

    // No rotation. Fast low-res full-page text scan first.
    for(let p=0;p<src.pageCount;p++){
      const fastCanvas=preprocessCanvas(await renderSourcePage(src,p,700))
      const fast=await recognizeTextFast(fastCanvas)
      const score=scoreFastPageText(fast.text)+fast.confidence*.04
      if(!best||score>best.score)best={pageIndex:p,score}
      update(index,{
        progress:Math.max(12,10+Math.round(((p+1)/src.pageCount)*34)),
        message:`${p+1}/${src.pageCount} 페이지 문맥 확인`
      })
    }

    if(!best)throw new Error('후보 페이지를 찾지 못했습니다.')

    update(index,{progress:54,message:'선택된 페이지 정밀 OCR 중'})
    const precise=preprocessCanvas(await renderSourcePage(src,best.pageIndex,1650))
    const tokens=await recognizeWordsPrecise(precise,best.pageIndex,(p,s)=>{
      update(index,{
        progress:Math.max(54,54+Math.round(p*30)),
        message:`정밀 OCR · ${s}`
      })
    })

    const blocks=detectSigningBlocks(tokens)
    const top=blocks[0]??null
    const fullPreview=precise.toDataURL('image/jpeg',.9)

    if(!top){
      stopSmoothProgress(index)
      update(index,{
        status:'failed',
        progress:100,
        message:'확인합니다 + 연/년·월·일 + 서명/(인) 문맥 탐지 실패',
        pageIndex:best.pageIndex,
        fullPreview,
        elapsedMs:performance.now()-started
      })
      return
    }

    const cropPreview=cropCanvas(precise,top.rect).toDataURL('image/jpeg',.96)

    stopSmoothProgress(index)
    update(index,{
      status:'success',
      progress:100,
      message:'서명영역 탐지 완료',
      pageIndex:top.pageIndex,
      confidence:top.confidence,
      fullPreview,
      cropPreview,
      elapsedMs:performance.now()-started,
      matched:{
        confirm:top.confirmLine,
        date:top.dateLine,
        signer:top.signerLine
      }
    })
  }

  async function start(){
    if(!files.length||processing)return
    setProcessing(true)
    setResults(files.map(emptyResult))
    for(let i=0;i<files.length;i++){
      try{
        await processOne(files[i],i)
      }catch(e){
        stopSmoothProgress(i)
        update(i,{
          status:'failed',
          progress:100,
          message:`오류: ${e instanceof Error?e.message:String(e)}`
        })
      }
    }
    setProcessing(false)
  }

  function selectFiles(list:FileList|null){
    if(!list)return
    const arr=Array.from(list)
      .filter(f=>{
        const n=f.name.toLowerCase()
        return f.type==='application/pdf'||f.type.startsWith('image/')||
          n.endsWith('.pdf')||n.endsWith('.jpg')||n.endsWith('.jpeg')||n.endsWith('.png')
      })
      .slice(0,5)
    setFiles(arr)
    setResults([])
  }

  function judge(index:number,j:FileResult['judgement']){
    update(index,{judgement:j})
  }

  const stats=useMemo(()=>{
    const judged=results.filter(r=>r.judgement)
    const correct=judged.filter(r=>r.judgement==='correct').length
    const partial=judged.filter(r=>r.judgement==='partial').length
    const total=judged.length
    return{
      total,correct,partial,
      exact:total?Math.round(correct/total*100):0,
      usable:total?Math.round((correct+partial)/total*100):0
    }
  },[results])

  return <div className="app">
    <header>
      <div>
        <p className="eyebrow">CONTEXT LAYOUT DETECTION · NO AUTO ROTATION</p>
        <h1>서명영역 탐지 검수 v8</h1>
        <p className="sub">
          ‘확인합니다’ 문장 → 그 아래의 연/년·월·일 → 서명/(인)/매수인 줄 구조를 함께 보고 서명 블록을 찾습니다.
        </p>
      </div>
    </header>

    <section className={`dropzone ${processing?'disabled':''}`} onClick={()=>!processing&&inputRef.current?.click()}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        hidden
        onChange={e=>selectFiles(e.target.files)}
      />
      <div className="uploadIcon">5</div>
      <strong>{files.length?`${files.length}개 파일 선택됨`:'PDF / JPG / PNG 최대 5개 선택'}</strong>
      <span>이번 버전에서는 자동 회전을 사용하지 않습니다.</span>
    </section>

    {files.length>0&&<section className="batchList">
      {files.map((f,i)=><div className="fileChip" key={f.name+i}>
        <b>{i+1}</b>
        <span>{f.name}</span>
      </div>)}
      <button className="startBtn" disabled={processing} onClick={start}>
        {processing?'분석 중…':'선택한 파일 분석 시작'}
      </button>
    </section>}

    {results.map((r,i)=><section className="resultCard card" key={r.id}>
      <div className="resultTop">
        <div>
          <p className="label">FILE {i+1} · {r.fileType.toUpperCase()}</p>
          <h2>{r.fileName}</h2>
        </div>
        <span className={`stateBadge ${r.status}`}>
          {r.status==='success'?`${Math.round(r.confidence*100)}%`:r.status}
        </span>
      </div>

      <div className="statusTop">
        <strong>{r.message}</strong>
        <span className="bigPercent">{r.progress}%</span>
      </div>
      <div className="progress"><i style={{width:`${r.progress}%`}}/></div>

      {r.cropPreview&&<>
        <div className="focusTitle">
          <div>
            <p className="label">DETECTED SIGNING BLOCK</p>
            <h3>탐지된 서명영역 확대</h3>
          </div>
          <span>{r.pageIndex!==null?`${r.pageIndex+1}/${r.pageCount} 페이지`:''}</span>
        </div>
        <div className="largeCrop">
          <img src={r.cropPreview} alt="탐지된 서명영역 확대"/>
        </div>

        {r.matched&&<div className="matchedStack">
          <div><span>확인 문장</span><b>{r.matched.confirm}</b></div>
          <div><span>날짜 줄</span><b>{r.matched.date}</b></div>
          <div><span>서명 줄</span><b>{r.matched.signer}</b></div>
        </div>}
      </>}

      {r.fullPreview&&<details className="fullDetails">
        <summary>전체 페이지 확인</summary>
        <div className="correctedPreview">
          <img src={r.fullPreview} alt="전체 페이지"/>
        </div>
      </details>}

      <div className="metaRow">
        <span>시간 <b>{(r.elapsedMs/1000).toFixed(1)}s</b></span>
      </div>

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
