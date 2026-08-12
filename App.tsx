import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSigningBlocks, scoreFastPageText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import { cropCanvas, loadSource, preprocessCanvas, renderSourcePage } from './source'
import type { FileResult } from './types'

const VERSION='10.0'
const BUILD='2026-08-12'

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
  cropPreview:null,
  elapsedMs:0
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

  const stopSmoothProgress=(index:number)=>{
    const id=progressTimers.current[index]
    if(id){
      clearInterval(id)
      delete progressTimers.current[index]
    }
  }

  const startSmoothProgress=(index:number)=>{
    stopSmoothProgress(index)
    progressTimers.current[index]=window.setInterval(()=>{
      setResults(prev=>prev.map((r,i)=>{
        if(i!==index||r.status!=='processing')return r
        const ceiling=r.progress<40?40:r.progress<70?70:r.progress<92?92:97
        return r.progress<ceiling?{...r,progress:r.progress+1}:r
      }))
    },110)
  }

  async function preciseDetect(
    src:Awaited<ReturnType<typeof loadSource>>,
    pageIndex:number,
    fileType:'pdf'|'image',
    index:number
  ){
    const maxSide=fileType==='image'?3200:2400
    const rendered=await renderSourcePage(src,pageIndex,maxSide,true)

    // First OCR pass
    let precise=preprocessCanvas(rendered,fileType==='image')
    let tokens=await recognizeWordsPrecise(precise,pageIndex,(p,s)=>{
      update(index,{
        progress:Math.max(58,58+Math.round(p*26)),
        message:'서명영역 정밀 판독 중'
      })
    })

    let blocks=detectSigningBlocks(tokens)

    // JPG/PNG fallback: second preprocessing variant only if first failed.
    if(!blocks.length&&fileType==='image'){
      update(index,{progress:86,message:'이미지 OCR 보정 재시도 중'})
      precise=preprocessCanvas(rendered,false)
      tokens=await recognizeWordsPrecise(precise,pageIndex,(p)=>{
        update(index,{progress:Math.max(86,86+Math.round(p*8))})
      })
      blocks=detectSigningBlocks(tokens)
    }

    return{precise,block:blocks[0]??null}
  }

  async function processOne(file:File,index:number){
    const started=performance.now()
    const fileType:FileResult['fileType']=
      file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')?'pdf':'image'

    update(index,{status:'processing',progress:1,message:'파일 여는 중'})
    startSmoothProgress(index)

    const src=await loadSource(file)
    update(index,{
      pageCount:src.pageCount,
      progress:7,
      message:'서명 페이지 찾는 중'
    })

    let best:{pageIndex:number;score:number}|null=null

    // Page selection only. Result never merges pages.
    for(let p=0;p<src.pageCount;p++){
      const fastMax=fileType==='image'?1500:950
      const canvas=await renderSourcePage(src,p,fastMax,fileType==='image')
      const fast=await recognizeTextFast(
        preprocessCanvas(canvas,fileType==='image')
      )

      const score=scoreFastPageText(fast.text)+fast.confidence*.03
      if(!best||score>best.score)best={pageIndex:p,score}

      update(index,{
        progress:Math.max(12,10+Math.round(((p+1)/src.pageCount)*38)),
        message:`서명 페이지 탐색 ${p+1}/${src.pageCount}`
      })
    }

    if(!best)throw new Error('서명 페이지 후보를 찾지 못했습니다.')

    update(index,{
      progress:56,
      message:`${best.pageIndex+1}페이지 서명영역 분석 중`
    })

    const {precise,block}=await preciseDetect(
      src,
      best.pageIndex,
      fileType,
      index
    )

    if(!block){
      stopSmoothProgress(index)
      update(index,{
        status:'failed',
        progress:100,
        message:'서명영역 탐지 실패',
        pageIndex:best.pageIndex,
        elapsedMs:performance.now()-started
      })
      return
    }

    const crop=cropCanvas(precise,block.rect)

    stopSmoothProgress(index)
    update(index,{
      status:'success',
      progress:100,
      message:'서명영역 탐지 완료',
      pageIndex:best.pageIndex,
      confidence:block.confidence,
      cropPreview:crop.toDataURL('image/jpeg',.97),
      elapsedMs:performance.now()-started
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
        return f.type==='application/pdf'||
          f.type==='image/jpeg'||
          f.type==='image/png'||
          n.endsWith('.pdf')||
          n.endsWith('.jpg')||
          n.endsWith('.jpeg')||
          n.endsWith('.png')
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
      total,
      exact:total?Math.round(correct/total*100):0,
      usable:total?Math.round((correct+partial)/total*100):0
    }
  },[results])

  return <div className="app">
    <header>
      <p className="eyebrow">SIGNING AREA ONLY</p>
      <h1>서명영역 탐지 검수 v{VERSION}</h1>
      <div className="versionBadge">BUILD {VERSION} · {BUILD}</div>
      <p className="sub">
        여러 페이지 중 실제 서명 페이지 하나만 선택하고, 날짜·매수인·서명 영역만 확대합니다.
      </p>
    </header>

    <section
      className={`dropzone ${processing?'disabled':''}`}
      onClick={()=>!processing&&inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        hidden
        onChange={e=>selectFiles(e.target.files)}
      />
      <div className="uploadIcon">5</div>
      <strong>
        {files.length?`${files.length}개 파일 선택됨`:'PDF / JPG / PNG 최대 5개'}
      </strong>
      <span>PDF와 이미지의 서명영역 탐지 정확도를 테스트합니다.</span>
    </section>

    {files.length>0&&<section className="batchList">
      {files.map((f,i)=>
        <div className="fileChip" key={f.name+i}>
          <b>{i+1}</b>
          <span>{f.name}</span>
        </div>
      )}
      <button
        className="startBtn"
        disabled={processing}
        onClick={start}
      >
        {processing?'분석 중…':'분석 시작'}
      </button>
    </section>}

    {results.map((r,i)=>
      <section className="resultCard card" key={r.id}>
        <div className="resultTop">
          <div>
            <p className="label">FILE {i+1}</p>
            <h2>{r.fileName}</h2>
          </div>
          {r.status==='success'&&
            <span className="successBadge">
              {Math.round(r.confidence*100)}%
            </span>
          }
        </div>

        <div className="statusTop">
          <strong>{r.message}</strong>
          <span className="bigPercent">{r.progress}%</span>
        </div>
        <div className="progress">
          <i style={{width:`${r.progress}%`}}/>
        </div>

        {r.cropPreview&&
          <div className="signatureOnly">
            <div className="signatureHeader">
              <h3>서명영역</h3>
              <span>
                {r.pageIndex!==null&&r.pageCount>1
                  ?`${r.pageIndex+1}/${r.pageCount} 페이지`
                  :''}
              </span>
            </div>

            <div className="signatureCrop">
              <img
                src={r.cropPreview}
                alt="탐지된 서명영역"
              />
            </div>
          </div>
        }

        {r.status==='success'&&
          <div className="judgeButtons">
            <button
              className={r.judgement==='correct'?'selected':''}
              onClick={()=>judge(i,'correct')}
            >
              정확함
            </button>
            <button
              className={r.judgement==='partial'?'selected':''}
              onClick={()=>judge(i,'partial')}
            >
              일부 포함
            </button>
            <button
              className={r.judgement==='wrong'?'selected':''}
              onClick={()=>judge(i,'wrong')}
            >
              틀림
            </button>
          </div>
        }
      </section>
    )}

    {stats.total>0&&
      <section className="stats compactStats">
        <div><span>평가</span><strong>{stats.total}</strong></div>
        <div><span>Exact</span><strong>{stats.exact}%</strong></div>
        <div><span>Usable</span><strong>{stats.usable}%</strong></div>
      </section>
    }
  </div>
}
