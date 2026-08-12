import { useEffect, useMemo, useRef, useState } from 'react'
import { detectSignatureCandidates } from './detection'
import { recognizeCanvas, terminateOCR } from './ocr'
import { cropCanvas, loadPdf, preprocessCanvas, renderPageForOCR, renderPagePreview, rotationForAttempt } from './pdf'
import type { PageAnalysis, SavedResult, SignatureCandidate, TestJudgement } from './types'

const STORAGE_KEY = 'signature-detector-results-v1'

function pct(n: number) {
  return `${Math.round(n * 100)}%`
}

function loadSaved(): SavedResult[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveJudgement(fileName: string, candidate: SignatureCandidate | null, judgement: TestJudgement) {
  const list = loadSaved()
  list.push({
    fileName,
    timestamp: Date.now(),
    score: candidate?.score ?? 0,
    confidence: candidate?.confidence ?? 0,
    pageIndex: candidate?.pageIndex ?? null,
    judgement,
  })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState('PDF를 올려주세요')
  const [progress, setProgress] = useState(0)
  const [analyses, setAnalyses] = useState<PageAnalysis[]>([])
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [debug, setDebug] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [saved, setSaved] = useState<SavedResult[]>(loadSaved())
  const inputRef = useRef<HTMLInputElement>(null)

  const candidates = useMemo(
    () => analyses.flatMap(a => a.candidates).sort((a, b) => b.score - a.score).slice(0, 3),
    [analyses],
  )
  const candidate = candidates[candidateIndex] ?? null
  const activePage = candidate ? analyses.find(a => a.pageIndex === candidate.pageIndex) : analyses[0]

  useEffect(() => () => { terminateOCR() }, [])

  async function analyzePdf(selected: File) {
    setFile(selected)
    setProcessing(true)
    setAnalyses([])
    setCandidateIndex(0)
    setProgress(0)
    setStatus('PDF를 여는 중…')

    try {
      const pdf = await loadPdf(selected)
      const pageAnalyses: PageAnalysis[] = []

      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p)
        const pageIndex = p - 1
        const previewDataUrl = await renderPagePreview(page)
        let best: PageAnalysis | null = null

        // Auto-rotation fallback. Stop early once the page has a strong candidate.
        for (let attempt = 0; attempt < 4; attempt++) {
          const rotation = rotationForAttempt(attempt)
          setStatus(`${p}/${pdf.numPages} 페이지 분석 · ${rotation}°`)
          const started = performance.now()
          const rendered = await renderPageForOCR(page, rotation)
          const preprocessed = preprocessCanvas(rendered)
          const tokens = await recognizeCanvas(preprocessed, pageIndex, (v, s) => {
            const pageBase = (p - 1) / pdf.numPages
            const pageShare = 1 / pdf.numPages
            setProgress(Math.min(.99, pageBase + v * pageShare))
            setStatus(`${p}/${pdf.numPages} 페이지 · ${s}`)
          })
          const pageCandidates = detectSignatureCandidates(tokens, rotation)

          const analysis: PageAnalysis = {
            pageIndex,
            width: rendered.width,
            height: rendered.height,
            rotation,
            tokens,
            candidates: pageCandidates,
            previewDataUrl,
            ocrDataUrl: preprocessed.toDataURL('image/jpeg', .85),
            elapsedMs: performance.now() - started,
          }

          if (!best || (pageCandidates[0]?.score ?? 0) > (best.candidates[0]?.score ?? 0)) best = analysis
          if ((pageCandidates[0]?.confidence ?? 0) >= 0.72 || (pageCandidates[0]?.score ?? 0) >= 105) break
        }

        if (best) pageAnalyses.push(best)
      }

      const globalCandidates = pageAnalyses.flatMap(a => a.candidates).sort((a, b) => b.score - a.score).slice(0, 3)
      setAnalyses(pageAnalyses)
      setProgress(1)
      if (!globalCandidates.length || globalCandidates[0].confidence < .28) {
        setStatus('서명 위치를 정확하게 찾지 못했어요')
      } else if (globalCandidates[0].confidence < .62) {
        setStatus('서명 위치로 예상되는 후보를 찾았어요')
      } else {
        setStatus('서명 위치를 찾았어요')
      }
    } catch (e) {
      console.error(e)
      setStatus(`오류: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setProcessing(false)
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f?.type === 'application/pdf' || f?.name.toLowerCase().endsWith('.pdf')) analyzePdf(f)
  }

  function judge(j: TestJudgement) {
    if (!file) return
    saveJudgement(file.name, candidate, j)
    setSaved(loadSaved())
  }

  function cropUrlFor(c: SignatureCandidate | null) {
    if (!c) return null
    const analysis = analyses.find(a => a.pageIndex === c.pageIndex)
    if (!analysis) return null
    // OCR source is saved as image URL. Reconstructing a canvas here is async, so the crop
    // preview uses CSS clipping below for instant display; the detector itself used high-res OCR coordinates.
    return analysis.ocrDataUrl
  }

  const stats = useMemo(() => {
    const total = saved.length
    const count = (v: TestJudgement) => saved.filter(s => s.judgement === v).length
    const correct = count('correct')
    const partial = count('partial')
    return {
      total, correct, partial, wrong: count('wrong'), failed: count('failed'),
      exact: total ? correct / total : 0,
      usable: total ? (correct + partial) / total : 0,
    }
  }, [saved])

  return (
    <div className="app">
      <header>
        <div>
          <p className="eyebrow">NO PAID AI · BROWSER OCR</p>
          <h1>서명영역 탐지 프로토타입</h1>
          <p className="sub">성능점검기록부에서 ‘연월일 / 매수인 / 서명’ 주변을 자동으로 찾습니다.</p>
        </div>
        <button className="ghost" onClick={() => setDebug(v => !v)}>{debug ? 'DEV 끄기' : 'DEV'}</button>
      </header>

      <section
        className={`dropzone ${processing ? 'disabled' : ''}`}
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => !processing && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) analyzePdf(f)
          }}
        />
        <div className="uploadIcon">PDF</div>
        <strong>{file ? file.name : '성능점검기록부 PDF 업로드'}</strong>
        <span>{processing ? '분석 중에는 잠시 기다려주세요.' : '클릭하거나 PDF를 여기에 드래그하세요.'}</span>
      </section>

      {(processing || file) && (
        <section className="statusCard">
          <div className="statusTop">
            <strong>{status}</strong>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div className="progress"><i style={{ width: `${progress * 100}%` }} /></div>
          <small>PDF.js 렌더 → 한글 OCR → 키워드/배치 점수화 → 회전 fallback</small>
        </section>
      )}

      {!processing && file && analyses.length > 0 && (
        <>
          <section className="resultGrid">
            <article className="card cropCard">
              <div className="cardHead">
                <div>
                  <p className="label">BEST CANDIDATE</p>
                  <h2>{candidate ? `후보 ${candidateIndex + 1} · ${pct(candidate.confidence)}` : '탐지 실패'}</h2>
                </div>
                {candidate && <span className={`confidence ${candidate.confidence >= .62 ? 'high' : 'medium'}`}>
                  {candidate.confidence >= .62 ? 'HIGH' : 'CHECK'}
                </span>}
              </div>

              {candidate && activePage ? (
                <>
                  <CropPreview imageUrl={cropUrlFor(candidate)!} rect={candidate.rotatedRect} />
                  <div className="chips">
                    {candidate.matchedKeywords.map(k => <span key={k}>{k}</span>)}
                  </div>
                  <div className="candidateNav">
                    <button disabled={candidateIndex === 0} onClick={() => setCandidateIndex(i => Math.max(0, i - 1))}>이전</button>
                    <b>{candidateIndex + 1} / {candidates.length}</b>
                    <button disabled={candidateIndex >= candidates.length - 1} onClick={() => setCandidateIndex(i => Math.min(candidates.length - 1, i + 1))}>다음</button>
                  </div>
                </>
              ) : (
                <div className="emptyResult">키워드 기반 후보를 만들지 못했습니다. DEV 모드에서 OCR 결과를 확인해보세요.</div>
              )}
            </article>

            <article className="card fullCard">
              <div className="cardHead">
                <div>
                  <p className="label">FULL PAGE</p>
                  <h2>전체 문서에서 보기</h2>
                </div>
                {candidate && <span className="pageBadge">{candidate.pageIndex + 1}페이지</span>}
              </div>
              {activePage && (
                <FullPagePreview
                  imageUrl={activePage.previewDataUrl}
                  rect={candidate?.rect ?? null}
                />
              )}
            </article>
          </section>

          <section className="judgeCard">
            <div>
              <strong>이 PDF의 탐지 결과는 어땠나요?</strong>
              <span>평가 데이터는 이 브라우저의 localStorage에만 저장됩니다.</span>
            </div>
            <div className="judgeButtons">
              <button onClick={() => judge('correct')}>정확함</button>
              <button onClick={() => judge('partial')}>일부 포함</button>
              <button onClick={() => judge('wrong')}>틀림</button>
              <button onClick={() => judge('failed')}>탐지 실패</button>
            </div>
          </section>

          {debug && (
            <section className="debugGrid">
              <article className="card">
                <p className="label">DETECTION DEBUG</p>
                <pre>{JSON.stringify(candidate ? {
                  page: candidate.pageIndex + 1,
                  rotation: candidate.rotation,
                  score: Math.round(candidate.score * 10) / 10,
                  confidence: candidate.confidence,
                  matchedKeywords: candidate.matchedKeywords,
                  rect: candidate.rect,
                  rotatedRect: candidate.rotatedRect,
                  breakdown: candidate.breakdown,
                } : null, null, 2)}</pre>
              </article>
              <article className="card">
                <p className="label">OCR TOKENS</p>
                <div className="tokenList">
                  {(activePage?.tokens ?? []).slice(0, 160).map((t, i) => (
                    <span key={i}>{t.text} <em>{Math.round(t.confidence)}</em></span>
                  ))}
                </div>
              </article>
            </section>
          )}

          <section className="stats">
            <div><span>테스트</span><strong>{stats.total}</strong></div>
            <div><span>정확</span><strong>{stats.correct}</strong></div>
            <div><span>일부 포함</span><strong>{stats.partial}</strong></div>
            <div><span>Exact</span><strong>{pct(stats.exact)}</strong></div>
            <div><span>Usable</span><strong>{pct(stats.usable)}</strong></div>
          </section>
        </>
      )}

      <footer>
        이 프로토타입은 자동 서명 기능이 아니라 <b>“서명영역을 비용 없이 찾을 수 있는가”</b>를 먼저 검증하기 위한 도구입니다.
      </footer>
    </div>
  )
}

function CropPreview({ imageUrl, rect }: { imageUrl: string, rect: {x:number,y:number,width:number,height:number} }) {
  // CSS clip is only the display layer; OCR itself ran on a high-resolution PDF render.
  // This keeps the UI immediate without storing very large canvases in React state.
  const aspect = Math.max(.35, Math.min(2.4, rect.width / rect.height))
  return (
    <div className="cropViewport" style={{ aspectRatio: `${aspect}` }}>
      <img
        src={imageUrl}
        alt="탐지 영역"
        style={{
          width: `${100 / rect.width}%`,
          height: `${100 / rect.height}%`,
          left: `${-(rect.x / rect.width) * 100}%`,
          top: `${-(rect.y / rect.height) * 100}%`,
        }}
      />
    </div>
  )
}

function FullPagePreview({ imageUrl, rect }: { imageUrl: string, rect: {x:number,y:number,width:number,height:number} | null }) {
  return (
    <div className="pagePreview">
      <img src={imageUrl} alt="PDF 페이지" />
      {rect && (
        <div className="detectedRect" style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}>
          <span>서명 후보</span>
        </div>
      )}
    </div>
  )
}
