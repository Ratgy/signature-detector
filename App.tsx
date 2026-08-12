import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSigningClusters, scoreOrientationText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadSource, preprocessCanvas, renderSourcePage } from './source'
import type { FileResult, Rotation } from './types'

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
  rotation:0,
  confidence:0,
  correctedPreview:null,
  cropPreview:null,
  elapsedMs:0,
  matched:null
})

export default function App(){
  const [files,setFiles]=useState<File[]>([])
  const [results,setResults]=useState<FileResult[]>([])
  const [processing,setProcessing]=useState(false)
  const inputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>()=>{terminateOCR()},[])

  const update=(index:number,patch:Partial<FileResult>)=>{
    setResults(prev=>prev.map((r,i)=>i===index?{...r,...patch}:r))
  }

  async function processOne(file:File,index:number){
    const started=performance.now()
    update(index,{status:'processing',progress:1,message:'파일 여는 중'})
    const src=await loadSource(file)
    update(index,{pageCount:src.pageCount,progress:4,message:'문서 방향 탐색 중'})

    let best:{pageIndex:number;rotation:Rotation;score:number}|null=null

    // For each page, test all rotations at low resolution.
    // JPG/PNG often arrive rotated, so orientation is a first-class part of detection.
    for(let p=0;p<src.pageCount;p++){
      for(const rotation of [0,90,180,270] as Rotation[]){
        const tiny=preprocessCanvas(await renderSourcePage(src,p,rotation,560))
        const fast=await recognizeTextFast(tiny)
        const score=scoreOrientationText(fast.text)+fast.confidence*.08
        if(!best||score>best.score)best={pageIndex:p,rotation,score}
        const done=((p*4)+([0,90,180,270] as Rotation[]).indexOf(rotation)+1)/(src.pageCount*4)
        update(index,{progress:5+Math.round(done*48),message:`${p+1}/${src.pageCount} 페이지 · ${rotation}° 확인`})
      }
    }

    if(!best)throw new Error('문서 방향 후보를 찾지 못했습니다.')

    update(index,{progress:58,message:'선택된 방향에서 정밀 OCR 중'})
    const precise=preprocessCanvas(await renderSourcePage(src,best.pageIndex,best.rotation,1500))
    const tokens=await recognizeWordsPrecise(precise,best.pageIndex,(p,s)=>{
      update(index,{progress:58+Math.round(p*30),message:`정밀 OCR · ${s}`})
    })

    const clusters=detectSigningClusters(tokens,best.rotation)
    const top=clusters[0]??null

    // Always show corrected orientation, even on detection failure.
    const correctedPreview=precise.toDataURL('image/jpeg',.9)

    if(!top){
      update(index,{
        status:'failed',
        progress:100,
        message:'확인합니다 + 연/년·월·일 + 서명/(인) 블록 탐지 실패',
        pageIndex:best.pageIndex,
        rotation:best.rotation,
        correctedPreview,
        elapsedMs:performance.now()-started
      })
      return
    }

    const cropPreview=cropCanvas(precise,top.rotatedRect).toDataURL('image/jpeg',.95)

    update(index,{
      status:'success',
      progress:100,
      message:'서명영역 탐지 완료',
      pageIndex:top.pageIndex,
      rotation:top.rotation,
      confidence:top.confidence,
      correctedPreview,
      cropPreview,
      elapsedMs:performance.now()-started,
      matched:top.matched
    })
  }

  async function start(){
    if(!files.length||processing)return
    setProcessing(true)
    setResults(files.map(emptyResult))
    for(let i=0;i<files.length;i++){
      try{await processOne(files[i],i)}
      catch(e){
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
        return f.type==='application/pdf'||f.type.startsWith('image/')||n.endsWith('.pdf')||n.endsWith('.jpg')||n.endsWith('.jpeg')||n.endsWith('.png')
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
        <p className="eyebrow">STRICT CLUSTER · PDF/JPG/PNG · AUTO ROTATE</p>
        <h1>서명영역 탐지 검수 v7</h1>
        <p className="sub">확인합니다 + 연/년·월·일 + 서명 또는 (인)이 가까이 있는 영역만 서명영역으로 인정합니다.</p>
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
      <span>회전된 이미지도 자동으로 방향을 판단합니다.</span>
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
            <p className="label">DETECTED SIGNING CLUSTER</p>
            <h3>탐지된 서명영역 확대</h3>
          </div>
          <span>{r.pageIndex!==null?`${r.pageIndex+1}/${r.pageCount} 페이지`:''}</span>
        </div>

        <div className="largeCrop">
          <img src={r.cropPreview} alt="탐지된 서명영역 확대"/>
        </div>

        {r.matched&&<div className="matchedGrid">
          <span>확인 <b>{r.matched.confirm}</b></span>
          <span>날짜 <b>{r.matched.date}</b></span>
          <span>서명 <b>{r.matched.signer}</b></span>
        </div>}
      </>}

      {r.correctedPreview&&<details className="fullDetails">
        <summary>자동 회전된 원본 확인 · {r.rotation}° → 정방향 표시</summary>
        <div className="correctedPreview"><img src={r.correctedPreview} alt="정방향 원본"/></div>
      </details>}

      <div className="metaRow">
        <span>선택 방향 <b>{r.rotation}°</b></span>
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
