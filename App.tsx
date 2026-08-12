import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  detectTarget
} from './detection'

import {
  recognizeContactSheet,
  terminateOCR
} from './ocr'

import {
  buildContactSheet,
  buildStrips,
  loadSource,
  renderFinalCrop,
  renderPage,
  tokensForMeta
} from './source'

import type {
  FileResult,
  TargetCandidate
} from './types'

const VERSION='14.0'
const BUILD='2026-08-13'

const makeId=()=>
  Math.random()
    .toString(36)
    .slice(2)

const emptyResult=(
  file:File
):FileResult=>({
  id:makeId(),
  fileName:file.name,
  fileType:
    file.type==='application/pdf'||
    file.name.toLowerCase().endsWith('.pdf')
      ?'pdf'
      :'image',
  status:'queued',
  progress:0,
  message:'대기 중',
  pageCount:0,
  confidence:0,
  cropPreview:null,
  elapsedMs:0
})

export default function App(){
  const [files,setFiles]=
    useState<File[]>([])

  const [results,setResults]=
    useState<FileResult[]>([])

  const [processing,setProcessing]=
    useState(false)

  const inputRef=
    useRef<HTMLInputElement>(null)

  const progressTimers=
    useRef<Record<number,number>>({})

  const progressTicks=
    useRef<Record<number,number>>({})

  useEffect(
    ()=>()=>{
      terminateOCR()
    },
    []
  )

  // v14 핵심:
  // progress는 어떤 경로에서도 현재 값보다 작아질 수 없다.
  function update(
    index:number,
    patch:Partial<FileResult>
  ){
    setResults(prev=>
      prev.map((result,i)=>{
        if(i!==index){
          return result
        }

        const next={
          ...result,
          ...patch
        }

        if(
          patch.progress!==undefined
        ){
          next.progress=
            Math.max(
              result.progress,
              Math.min(
                100,
                patch.progress
              )
            )
        }

        return next
      })
    )
  }

  function stopProgress(
    index:number
  ){
    const id=
      progressTimers.current[index]

    if(id){
      clearInterval(id)
      delete progressTimers.current[index]
      delete progressTicks.current[index]
    }
  }

  function startProgress(
    index:number
  ){
    stopProgress(index)

    progressTicks.current[index]=0

    progressTimers.current[index]=
      window.setInterval(()=>{
        progressTicks.current[index]=
          (
            progressTicks.current[index]||
            0
          )+1

        const tick=
          progressTicks.current[index]

        setResults(prev=>
          prev.map((result,i)=>{
            if(
              i!==index||
              result.status!=='processing'
            ){
              return result
            }

            if(result.progress>=97){
              return result
            }

            // 초반에는 빠르게, 후반에는 천천히.
            // 긴 OCR에서도 97%에 너무 빨리 도달해 멈춰 보이지 않게 한다.
            const shouldMove=
              result.progress<60
                ?true
                :result.progress<85
                  ?tick%3===0
                  :tick%8===0

            if(!shouldMove){
              return result
            }

            return{
              ...result,
              progress:
                Math.min(
                  97,
                  result.progress+1
                )
            }
          })
        )
      },140)
  }

  function bestFromContact(
    contactTokens:
      Awaited<
        ReturnType<
          typeof recognizeContactSheet
        >
      >,
    sheet:
      HTMLCanvasElement,
    metas:
      ReturnType<
        typeof buildContactSheet
      >['metas']
  ){
    let best:
      TargetCandidate|null=null

    for(const meta of metas){
      const localTokens=
        tokensForMeta(
          contactTokens,
          sheet,
          meta
        )

      const target=
        detectTarget(
          localTokens,
          meta.strip.pageIndex,
          meta.strip.rect
        )

      if(
        target &&
        (
          !best ||
          target.score>best.score
        )
      ){
        best=target
      }
    }

    return best
  }

  async function scanPage(
    src:
      Awaited<
        ReturnType<
          typeof loadSource
        >
      >,
    pageIndex:number,
    mode:'gray'|'adaptive',
    splitWide:boolean,
    index:number,
    pageNumber:number,
    pageCount:number
  ){
    const page=
      await renderPage(
        src,
        pageIndex,
        src.type==='image'
          ?2100
          :1750
      )

    const strips=
      buildStrips(
        page,
        pageIndex,
        splitWide
      )

    const contact=
      buildContactSheet(
        page,
        strips,
        mode,
        mode==='gray'
          ?1080
          :1240
      )

    const tokens=
      await recognizeContactSheet(
        contact.canvas,
        pageIndex,
        p=>{
          const base=
            mode==='gray'
              ?18
              :72

          const span=
            mode==='gray'
              ?46
              :20

          const pageShare=
            span/
            Math.max(
              1,
              pageCount
            )

          update(
            index,
            {
              progress:
                base+
                (
                  pageNumber-1+
                  p
                )*
                pageShare,
              message:
                mode==='gray'
                  ?'서명영역 판독 중'
                  :'스캔 보정 판독 중'
            }
          )
        }
      )

    return bestFromContact(
      tokens,
      contact.canvas,
      contact.metas
    )
  }

  async function processOne(
    file:File,
    index:number
  ){
    const started=
      performance.now()

    update(
      index,
      {
        status:'processing',
        progress:1,
        message:'문서 준비 중'
      }
    )

    startProgress(index)

    const src=
      await loadSource(file)

    update(
      index,
      {
        pageCount:src.pageCount,
        progress:8,
        message:'스캔 페이지 확인 중'
      }
    )

    // 중요:
    // 스캔 PDF에 부정확한 hidden OCR text layer가 있어도
    // v14에서는 사용하지 않는다.
    // PDF/JPG/PNG 모두 같은 이미지 기반 파이프라인을 탄다.

    let best:
      TargetCandidate|null=null

    // PASS 1
    // 모든 위치를 상/중/하 가정 없이 4개 겹침 strip으로 커버.
    for(
      let pageIndex=0;
      pageIndex<src.pageCount;
      pageIndex++
    ){
      const target=
        await scanPage(
          src,
          pageIndex,
          'gray',
          true,
          index,
          pageIndex+1,
          src.pageCount
        )

      if(
        target &&
        (
          !best ||
          target.score>best.score
        )
      ){
        best=target
      }

      // 엄격한 완성 패턴만 0.90 이상에 도달한다.
      // 이 경우 다른 페이지까지 읽지 않고 즉시 종료.
      if(
        target &&
        target.confidence>=.90
      ){
        best=target
        break
      }
    }

    // 가로가 긴 단일 landscape 문서를
    // 좌/우로 나눈 탓에 못 찾은 경우:
    // 같은 문서를 전체 폭 strip으로 한 번만 재검사.
    if(
      !best ||
      best.confidence<.66
    ){
      for(
        let pageIndex=0;
        pageIndex<src.pageCount;
        pageIndex++
      ){
        const target=
          await scanPage(
            src,
            pageIndex,
            'gray',
            false,
            index,
            pageIndex+1,
            src.pageCount
          )

        if(
          target &&
          (
            !best ||
            target.score>best.score
          )
        ){
          best=target
        }

        if(
          target &&
          target.confidence>=.90
        ){
          best=target
          break
        }
      }
    }

    // PASS 2
    // 완전한 blank date + buyer 구조가 아직 없을 때만
    // 촬영/스캔 얼룩 보정 adaptive OCR.
    if(
      !best ||
      best.confidence<.66
    ){
      for(
        let pageIndex=0;
        pageIndex<src.pageCount;
        pageIndex++
      ){
        const target=
          await scanPage(
            src,
            pageIndex,
            'adaptive',
            true,
            index,
            pageIndex+1,
            src.pageCount
          )

        if(
          target &&
          (
            !best ||
            target.score>best.score
          )
        ){
          best=target
        }

        if(
          target &&
          target.confidence>=.86
        ){
          best=target
          break
        }
      }
    }

    if(
      !best ||
      best.confidence<.60
    ){
      stopProgress(index)

      update(
        index,
        {
          status:'failed',
          progress:100,
          message:
            '서명영역을 찾지 못했습니다.',
          elapsedMs:
            performance.now()-
            started
        }
      )

      return
    }

    update(
      index,
      {
        progress:94,
        message:'서명영역 확대 중'
      }
    )

    const crop=
      await renderFinalCrop(
        src,
        best.pageIndex,
        best.targetRect,
        40
      )

    stopProgress(index)

    update(
      index,
      {
        status:'success',
        progress:100,
        message:'완료',
        confidence:
          best.confidence,
        cropPreview:
          crop.toDataURL(
            'image/jpeg',
            .98
          ),
        elapsedMs:
          performance.now()-
          started
      }
    )
  }

  async function start(){
    if(
      !files.length||
      processing
    ){
      return
    }

    setProcessing(true)
    setResults(
      files.map(emptyResult)
    )

    for(
      let i=0;
      i<files.length;
      i++
    ){
      try{
        await processOne(
          files[i],
          i
        )
      }catch(error){
        stopProgress(i)

        update(
          i,
          {
            status:'failed',
            progress:100,
            message:
              `오류: ${
                error instanceof Error
                  ?error.message
                  :String(error)
              }`
          }
        )
      }
    }

    setProcessing(false)
  }

  function selectFiles(
    list:FileList|null
  ){
    if(!list){
      return
    }

    const selected=
      Array.from(list)
        .filter(file=>{
          const name=
            file.name
              .toLowerCase()

          return(
            file.type===
              'application/pdf'||
            file.type===
              'image/jpeg'||
            file.type===
              'image/png'||
            name.endsWith('.pdf')||
            name.endsWith('.jpg')||
            name.endsWith('.jpeg')||
            name.endsWith('.png')
          )
        })
        .slice(0,5)

    setFiles(selected)
    setResults([])
  }

  function judge(
    index:number,
    judgement:
      FileResult['judgement']
  ){
    update(
      index,
      {judgement}
    )
  }

  const stats=useMemo(()=>{
    const judged=
      results.filter(
        result=>result.judgement
      )

    const correct=
      judged.filter(
        result=>
          result.judgement===
          'correct'
      ).length

    const partial=
      judged.filter(
        result=>
          result.judgement===
          'partial'
      ).length

    const total=
      judged.length

    return{
      total,
      exact:
        total
          ?Math.round(
            correct/
            total*
            100
          )
          :0,
      usable:
        total
          ?Math.round(
            (
              correct+
              partial
            )/
            total*
            100
          )
          :0
    }
  },[results])

  return(
    <div className="app">
      <header>
        <p className="eyebrow">
          SCAN-FIRST · STRICT BLANK SIGNING ROW
        </p>

        <h1>
          서명영역 탐지 검수 v{VERSION}
        </h1>

        <div className="versionBadge">
          BUILD {VERSION} · {BUILD}
        </div>

        <p className="sub">
          숫자가 없는 년·월·일과
          매수인·서명 영역만 찾아 확대합니다.
        </p>
      </header>

      <section
        className={
          `dropzone ${
            processing
              ?'disabled'
              :''
          }`
        }
        onClick={()=>
          !processing &&
          inputRef.current?.click()
        }
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          hidden
          onChange={(event:any)=>
            selectFiles(
              event.target.files
            )
          }
        />

        <div className="uploadIcon">
          5
        </div>

        <strong>
          {
            files.length
              ?`${files.length}개 파일 선택됨`
              :'PDF / JPG / PNG 최대 5개'
          }
        </strong>

        <span>
          스캔본에서도 동일한 방식으로 서명란을 찾습니다.
        </span>
      </section>

      {
        files.length>0 &&
        <section className="batchList">
          {
            files.map(
              (file,i)=>
                <div
                  className="fileChip"
                  key={`${file.name}-${i}`}
                >
                  <b>{i+1}</b>
                  <span>
                    {file.name}
                  </span>
                </div>
            )
          }

          <button
            className="startBtn"
            disabled={processing}
            onClick={start}
          >
            {
              processing
                ?'분석 중…'
                :'분석 시작'
            }
          </button>
        </section>
      }

      {
        results.map(
          (result,i)=>
            <section
              className="resultCard card"
              key={result.id}
            >
              <div className="resultTop">
                <div>
                  <p className="label">
                    FILE {i+1}
                  </p>

                  <h2>
                    {result.fileName}
                  </h2>
                </div>

                {
                  result.status===
                    'success' &&
                  <span className="successBadge">
                    {
                      Math.round(
                        result.confidence*
                        100
                      )
                    }%
                  </span>
                }
              </div>

              {
                result.status===
                  'processing' &&
                <>
                  <div className="statusTop">
                    <strong>
                      {result.message}
                    </strong>

                    <span className="bigPercent">
                      {result.progress}%
                    </span>
                  </div>

                  <div className="progress">
                    <i
                      style={{
                        width:
                          `${result.progress}%`
                      }}
                    />
                  </div>
                </>
              }

              {
                result.cropPreview &&
                <div className="signatureOnly">
                  <div className="signatureHeader">
                    <h3>
                      서명영역
                    </h3>
                  </div>

                  <div className="signatureCrop v14Crop">
                    <img
                      src={
                        result.cropPreview
                      }
                      alt="탐지된 서명영역"
                    />
                  </div>
                </div>
              }

              {
                result.status===
                  'failed' &&
                <div className="failureText">
                  서명영역을 찾지 못했습니다.
                </div>
              }

              {
                result.status===
                  'success' &&
                <div className="judgeButtons">
                  <button
                    className={
                      result.judgement===
                        'correct'
                        ?'selected'
                        :''
                    }
                    onClick={()=>
                      judge(
                        i,
                        'correct'
                      )
                    }
                  >
                    정확함
                  </button>

                  <button
                    className={
                      result.judgement===
                        'partial'
                        ?'selected'
                        :''
                    }
                    onClick={()=>
                      judge(
                        i,
                        'partial'
                      )
                    }
                  >
                    일부 포함
                  </button>

                  <button
                    className={
                      result.judgement===
                        'wrong'
                        ?'selected'
                        :''
                    }
                    onClick={()=>
                      judge(
                        i,
                        'wrong'
                      )
                    }
                  >
                    틀림
                  </button>
                </div>
              }
            </section>
        )
      }

      {
        stats.total>0 &&
        <section className="stats compactStats">
          <div>
            <span>평가</span>
            <strong>
              {stats.total}
            </strong>
          </div>

          <div>
            <span>Exact</span>
            <strong>
              {stats.exact}%
            </strong>
          </div>

          <div>
            <span>Usable</span>
            <strong>
              {stats.usable}%
            </strong>
          </div>
        </section>
      }
    </div>
  )
}
