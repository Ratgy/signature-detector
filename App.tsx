import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSigningBlocks, scoreFastPageText } from './detection'
import { recognizeTextFast, recognizeWordsPrecise, terminateOCR } from './ocr'
import {
  cropCanvasWithMargin,
  cropNormalized,
  getPdfNativeText,
  loadSource,
  preprocessCanvas,
  renderSourcePage
} from './source'
import type { FileResult, OCRToken } from './types'

const VERSION='12.0'
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
  pageIndex:null,
  confidence:0,
  cropPreview:null,
  elapsedMs:0
})

function remapTokens(
  tokens:OCRToken[],
  roi:{x:number;y:number;width:number;height:number}
){
  return tokens.map(t=>({
    ...t,
    rect:{
      x:roi.x+t.rect.x*roi.width,
      y:roi.y+t.rect.y*roi.height,
      width:t.rect.width*roi.width,
      height:t.rect.height*roi.height
    }
  }))
}

export default function App(){
  const [files,setFiles]=useState<File[]>([])
  const [results,setResults]=useState<FileResult[]>([])
  const [processing,setProcessing]=useState(false)

  const inputRef=useRef<HTMLInputElement>(null)
  const timers=useRef<Record<number,number>>({})

  useEffect(()=>()=>{terminateOCR()},[])

  const update=(index:number,patch:Partial<FileResult>)=>{
    setResults(prev=>prev.map((r,i)=>
      i===index?{...r,...patch}:r
    ))
  }

  const stopProgress=(index:number)=>{
    const id=timers.current[index]
    if(id){
      clearInterval(id)
      delete timers.current[index]
    }
  }

  const startProgress=(index:number)=>{
    stopProgress(index)

    timers.current[index]=window.setInterval(()=>{
      setResults(prev=>prev.map((r,i)=>{
        if(i!==index||r.status!=='processing')return r

        const ceiling=
          r.progress<40?40:
          r.progress<70?70:
          r.progress<91?91:97

        return r.progress<ceiling
          ?{...r,progress:r.progress+1}
          :r
      }))
    },105)
  }

  async function preciseImageFallback(
    rendered:HTMLCanvasElement,
    pageIndex:number,
    index:number
  ){
    const rois=[
      {x:0,y:.48,width:1,height:.52},
      {x:0,y:.24,width:1,height:.52}
    ]

    let allTokens:OCRToken[]=[]

    for(let i=0;i<rois.length;i++){
      update(index,{
        progress:88+i*4,
        message:'이미지 세부 영역 재판독 중'
      })

      const roiCanvas=cropNormalized(rendered,rois[i])
      const processed=preprocessCanvas(
        roiCanvas,
        i===0?'strong':'binary'
      )

      const tokens=await recognizeWordsPrecise(
        processed,
        pageIndex,
        undefined,
        true
      )

      allTokens.push(...remapTokens(tokens,rois[i]))
    }

    return allTokens
  }

  async function processOne(
    file:File,
    index:number
  ){
    const started=performance.now()

    const fileType:FileResult['fileType']=
      file.type==='application/pdf'||
      file.name.toLowerCase().endsWith('.pdf')
        ?'pdf':'image'

    update(index,{
      status:'processing',
      progress:1,
      message:'파일 여는 중'
    })

    startProgress(index)

    const src=await loadSource(file)

    update(index,{
      pageCount:src.pageCount,
      progress:6,
      message:'서명 페이지 찾는 중'
    })

    let best:{pageIndex:number;score:number}|null=null

    if(fileType==='pdf'){
      // v12: PDF는 먼저 내장 텍스트 레이어만 읽는다. OCR보다 훨씬 빠르다.
      // 텍스트 레이어가 없는 스캔 PDF일 때만 저해상도 OCR fallback.
      let nativeFound=false
      for(let p=0;p<src.pageCount;p++){
        const text=await getPdfNativeText(src,p)
        const score=scoreFastPageText(text)
        if(text.trim()) nativeFound=true
        if(!best||score>best.score) best={pageIndex:p,score}
        update(index,{
          progress:10+Math.round(((p+1)/src.pageCount)*22),
          message:`서명 페이지 탐색 ${p+1}/${src.pageCount}`
        })
      }

      if(!nativeFound || !best || best.score<100){
        best=null
        for(let p=0;p<src.pageCount;p++){
          const canvas=await renderSourcePage(src,p,900,false)
          const fast=await recognizeTextFast(preprocessCanvas(canvas,'strong'))
          const score=scoreFastPageText(fast.text)+fast.confidence*.03
          if(!best||score>best.score) best={pageIndex:p,score}
          update(index,{
            progress:32+Math.round(((p+1)/src.pageCount)*18),
            message:`스캔 PDF 탐색 ${p+1}/${src.pageCount}`
          })
        }
      }
    }else{
      // JPG/PNG는 페이지 탐색 OCR을 따로 하지 않는다.
      // 같은 이미지를 두 번 OCR하던 v11의 병목 제거.
      best={pageIndex:0,score:999}
      update(index,{progress:34,message:'이미지 서명영역 분석 준비'})
    }

    if(!best){
      throw new Error('서명 페이지 후보를 찾지 못했습니다.')
    }

    update(index,{
      progress:55,
      message:`${best.pageIndex+1}페이지 서명영역 분석 중`
    })

    const preciseMax=fileType==='image'?3000:2300

    const rendered=await renderSourcePage(
      src,
      best.pageIndex,
      preciseMax,
      true
    )

    let processed=preprocessCanvas(
      rendered,
      fileType==='image'?'strong':'normal'
    )

    let tokens=await recognizeWordsPrecise(
      processed,
      best.pageIndex,
      p=>{
        update(index,{
          progress:Math.max(
            56,
            56+Math.round(p*27)
          ),
          message:'서명영역 정밀 판독 중'
        })
      },
      fileType==='image'
    )

    let blocks=detectSigningBlocks(tokens)

    if(!blocks.length&&fileType==='image'){
      update(index,{
        progress:85,
        message:'이미지 OCR 보정 재시도 중'
      })

      processed=preprocessCanvas(rendered,'binary')

      tokens=await recognizeWordsPrecise(
        processed,
        best.pageIndex
      )

      blocks=detectSigningBlocks(tokens)
    }

    if(!blocks.length&&fileType==='image'){
      const bandTokens=await preciseImageFallback(
        rendered,
        best.pageIndex,
        index
      )

      blocks=detectSigningBlocks(bandTokens)

      if(blocks.length){
        tokens=bandTokens
      }
    }

    const top=blocks[0]??null

    if(!top){
      stopProgress(index)

      update(index,{
        status:'failed',
        progress:100,
        message:'서명영역 탐지 실패',
        pageIndex:best.pageIndex,
        elapsedMs:performance.now()-started
      })

      return
    }

    // 최종 결과는 원본 렌더 이미지에서,
    // 탐지된 년/월/일 + 매수인 + 서명 영역에 40px margin만 추가.
    const crop=cropCanvasWithMargin(
      rendered,
      top.rect,
      40
    )

    stopProgress(index)

    update(index,{
      status:'success',
      progress:100,
      message:'서명영역 탐지 완료',
      pageIndex:best.pageIndex,
      confidence:top.confidence,
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
            e instanceof Error?e.message:String(e)
          }`
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

    setFiles(arr)
    setResults([])
  }

  function judge(
    index:number,
    j:FileResult['judgement']
  ){
    update(index,{judgement:j})
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
        BLANK DATE + BUYER SIGNING AREA
      </p>

      <h1>
        서명영역 탐지 검수 v{VERSION}
      </h1>

      <div className="versionBadge">
        BUILD {VERSION} · {BUILD}
      </div>

      <p className="sub">
        숫자가 입력되지 않은 년·월·일과
        매수인·서명 영역만 확대합니다.
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
        비어 있는 날짜·매수인 서명란만 탐지합니다.
      </span>
    </section>

    {files.length>0&&
      <section className="batchList">
        {files.map((f,i)=>
          <div
            className="fileChip"
            key={f.name+i}
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
              {Math.round(
                r.confidence*100
              )}%
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

            <div className="signatureCrop v11Crop">
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
