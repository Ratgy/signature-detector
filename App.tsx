import { useEffect, useMemo, useRef, useState } from 'react'
import { detectTarget } from './detection'
import { recognizeRegion, terminateOCR } from './ocr'
import {
  buildSearchRegions,
  filterTokensInRect,
  getNativePdfTokens,
  loadSource,
  preprocess,
  remapTokens,
  cropRegion,
  renderFinalCrop,
  renderPage
} from './source'
import type {
  FileResult,
  SearchRegion,
  TargetCandidate
} from './types'

const VERSION='13.1'
const BUILD='2026-08-12'

const makeId=()=>Math.random().toString(36).slice(2)

const emptyResult=(file:File):FileResult=>({
  id:makeId(),
  fileName:file.name,
  fileType:
    file.type==='application/pdf'||
    file.name.toLowerCase().endsWith('.pdf')
      ?'pdf':'image',
  status:'queued',
  progress:0,
  message:'대기 중',
  pageCount:0,
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
    setResults(prev=>prev.map((r,i)=>
      i===index?{...r,...patch}:r
    ))
  }

  function stopProgress(index:number){
    const id=progressTimers.current[index]
    if(id){
      clearInterval(id)
      delete progressTimers.current[index]
    }
  }

  function startProgress(index:number){
    stopProgress(index)

    progressTimers.current[index]=window.setInterval(()=>{
      setResults(prev=>prev.map((r,i)=>{
        if(i!==index||r.status!=='processing')return r

        const ceiling=
          r.progress<35?35:
          r.progress<65?65:
          r.progress<90?90:97

        return r.progress<ceiling
          ?{...r,progress:r.progress+1}
          :r
      }))
    },90)
  }

  async function tryNativePdf(
    src:Awaited<ReturnType<typeof loadSource>>,
    regions:SearchRegion[]
  ):Promise<TargetCandidate|null>{
    if(src.type!=='pdf')return null

    const cache=new Map<number,Awaited<ReturnType<typeof getNativePdfTokens>>>()

    for(const region of regions){
      if(!cache.has(region.pageIndex)){
        cache.set(
          region.pageIndex,
          await getNativePdfTokens(src,region.pageIndex)
        )
      }

      const pageTokens=cache.get(region.pageIndex) ?? []
      if(!pageTokens.length)continue

      const inRegion=filterTokensInRect(
        pageTokens,
        region.rect
      )

      const local=inRegion.map(t=>({
        ...t,
        rect:{
          x:(t.rect.x-region.rect.x)/region.rect.width,
          y:(t.rect.y-region.rect.y)/region.rect.height,
          width:t.rect.width/region.rect.width,
          height:t.rect.height/region.rect.height
        }
      }))

      const target=detectTarget(
        local,
        region.pageIndex,
        region.rect
      )

      if(target&&target.confidence>=.68){
        return target
      }
    }

    return null
  }

  async function tryOcrRegions(
    src:Awaited<ReturnType<typeof loadSource>>,
    regions:SearchRegion[],
    index:number
  ):Promise<TargetCandidate|null>{
    // 페이지 canvas는 한 번만 렌더하고 여러 ROI가 재사용한다.
    const pageCache=new Map<number,HTMLCanvasElement>()

    async function pageCanvas(pageIndex:number){
      if(!pageCache.has(pageIndex)){
        pageCache.set(
          pageIndex,
          await renderPage(
            src,
            pageIndex,
            src.type==='image'?2300:1850
          )
        )
      }
      return pageCache.get(pageIndex)!
    }

    // pass 0: gray, 작은 하단 ROI 우선.
    // pass 1: adaptive, 1차 실패 때만.
    for(let pass=0;pass<2;pass++){
      for(let ri=0;ri<regions.length;ri++){
        const region=regions[ri]

        if(
          pass===0 &&
          region.id.endsWith('-full')
        ){
          continue
        }

        update(index,{
          progress:Math.max(
            18,
            18+Math.round(
              (
                ri/
                Math.max(1,regions.length)
              )*46
            )
          ),
          message:
            pass===0
              ?'서명란 후보 확인 중'
              :'사진 OCR 보정 확인 중'
        })

        const page=await pageCanvas(
          region.pageIndex
        )

        const roi=cropRegion(
          page,
          region.rect,
          pass===0?1380:1540
        )

        const processed=preprocess(
          roi,
          pass===0?'gray':'adaptive'
        )

        const localTokens=await recognizeRegion(
          processed,
          region.pageIndex,
          undefined,
          pass===1
        )

        const target=detectTarget(
          localTokens,
          region.pageIndex,
          region.rect
        )

        if(
          target&&
          target.confidence>=(
            pass===0?.60:.56
          )
        ){
          return target
        }
      }
    }

    return null
  }

  async function processOne(file:File,index:number){
    const started=performance.now()

    update(index,{
      status:'processing',
      progress:1,
      message:'문서 확인 중'
    })
    startProgress(index)

    const src=await loadSource(file)

    update(index,{
      pageCount:src.pageCount,
      progress:8,
      message:'서명 페이지 분리 중'
    })

    const regions=await buildSearchRegions(src)

    // 1. PDF 텍스트 레이어: OCR 없이 즉시 좌표 탐색.
    let target=await tryNativePdf(src,regions)

    // 2. 스캔 PDF / JPG / PNG: 작은 논리 페이지 하단 ROI부터 OCR.
    if(!target){
      update(index,{
        progress:16,
        message:'서명란 판독 중'
      })

      target=await tryOcrRegions(
        src,
        regions,
        index
      )
    }

    if(!target){
      stopProgress(index)
      update(index,{
        status:'failed',
        progress:100,
        message:'서명영역 탐지 실패',
        elapsedMs:performance.now()-started
      })
      return
    }

    update(index,{
      progress:93,
      message:'서명영역 확대 중'
    })

    const crop=await renderFinalCrop(
      src,
      target.pageIndex,
      target.targetRect,
      40
    )

    stopProgress(index)

    update(index,{
      status:'success',
      progress:100,
      message:'완료',
      confidence:target.confidence,
      cropPreview:crop.toDataURL('image/jpeg',.98),
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
        stopProgress(i)
        update(i,{
          status:'failed',
          progress:100,
          message:`오류: ${
            e instanceof Error
              ?e.message
              :String(e)
          }`
        })
      }
    }

    setProcessing(false)
  }

  function selectFiles(list:FileList|null){
    if(!list)return

    const selected=Array.from(list)
      .filter(f=>{
        const n=f.name.toLowerCase()
        return(
          f.type==='application/pdf'||
          f.type==='image/jpeg'||
          f.type==='image/png'||
          n.endsWith('.pdf')||
          n.endsWith('.jpg')||
          n.endsWith('.jpeg')||
          n.endsWith('.png')
        )
      })
      .slice(0,5)

    setFiles(selected)
    setResults([])
  }

  function judge(
    index:number,
    judgement:FileResult['judgement']
  ){
    update(index,{judgement})
  }

  const stats=useMemo(()=>{
    const judged=results.filter(r=>r.judgement)
    const correct=judged.filter(
      r=>r.judgement==='correct'
    ).length
    const partial=judged.filter(
      r=>r.judgement==='partial'
    ).length
    const total=judged.length

    return{
      total,
      exact:total
        ?Math.round(correct/total*100)
        :0,
      usable:total
        ?Math.round((correct+partial)/total*100)
        :0
    }
  },[results])

  return <div className="app">
    <header>
      <p className="eyebrow">
        LOGICAL PAGE ROI · BLANK BUYER SIGNATURE
      </p>

      <h1>
        서명영역 탐지 검수 v{VERSION}
      </h1>

      <div className="versionBadge">
        BUILD {VERSION} · {BUILD}
      </div>

      <p className="sub">
        숫자가 없는 년·월·일과 매수인·서명 영역만 찾아 확대합니다.
      </p>
    </header>

    <section
      className={`dropzone ${
        processing?'disabled':''
      }`}
      onClick={()=>
        !processing&&inputRef.current?.click()
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        hidden
        onChange={e=>
          selectFiles(e.target.files)
        }
      />

      <div className="uploadIcon">5</div>

      <strong>
        {files.length
          ?`${files.length}개 파일 선택됨`
          :'PDF / JPG / PNG 최대 5개'
        }
      </strong>

      <span>
        서명란이 있는 논리 페이지만 자동으로 선택합니다.
      </span>
    </section>

    {files.length>0&&
      <section className="batchList">
        {files.map((f,i)=>
          <div
            className="fileChip"
            key={`${f.name}-${i}`}
          >
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
      </section>
    }

    {results.map((r,i)=>
      <section
        className="resultCard card"
        key={r.id}
      >
        <div className="resultTop">
          <div>
            <p className="label">
              FILE {i+1}
            </p>
            <h2>{r.fileName}</h2>
          </div>

          {r.status==='success'&&
            <span className="successBadge">
              {Math.round(r.confidence*100)}%
            </span>
          }
        </div>

        {r.status==='processing'&&<>
          <div className="statusTop">
            <strong>{r.message}</strong>
            <span className="bigPercent">
              {r.progress}%
            </span>
          </div>

          <div className="progress">
            <i
              style={{
                width:`${r.progress}%`
              }}
            />
          </div>
        </>}

        {r.cropPreview&&
          <div className="signatureOnly">
            <div className="signatureHeader">
              <h3>서명영역</h3>
            </div>

            <div className="signatureCrop v13Crop">
              <img
                src={r.cropPreview}
                alt="탐지된 서명영역"
              />
            </div>
          </div>
        }

        {r.status==='failed'&&
          <div className="failureText">
            서명영역을 찾지 못했습니다.
          </div>
        }

        {r.status==='success'&&
          <div className="judgeButtons">
            <button
              className={
                r.judgement==='correct'
                  ?'selected':''
              }
              onClick={()=>
                judge(i,'correct')
              }
            >
              정확함
            </button>

            <button
              className={
                r.judgement==='partial'
                  ?'selected':''
              }
              onClick={()=>
                judge(i,'partial')
              }
            >
              일부 포함
            </button>

            <button
              className={
                r.judgement==='wrong'
                  ?'selected':''
              }
              onClick={()=>
                judge(i,'wrong')
              }
            >
              틀림
            </button>
          </div>
        }
      </section>
    )}

    {stats.total>0&&
      <section className="stats compactStats">
        <div>
          <span>평가</span>
          <strong>{stats.total}</strong>
        </div>

        <div>
          <span>Exact</span>
          <strong>{stats.exact}%</strong>
        </div>

        <div>
          <span>Usable</span>
          <strong>{stats.usable}%</strong>
        </div>
      </section>
    }
  </div>
}
