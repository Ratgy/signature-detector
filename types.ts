export type Rotation = 0 | 90 | 180 | 270

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OCRToken {
  text: string
  confidence: number
  rect: NormalizedRect
  pageIndex: number
}

export interface KeywordMatch extends OCRToken {
  keyword: string
  similarity: number
  weight: number
}

export interface ScoreBreakdown {
  keyword: number
  proximity: number
  layout: number
  position: number
  ocr: number
}

export interface SignatureCandidate {
  id: string
  pageIndex: number
  rect: NormalizedRect
  rotatedRect: NormalizedRect
  rotation: Rotation
  score: number
  confidence: number
  matchedKeywords: string[]
  breakdown: ScoreBreakdown
}

export interface PageAnalysis {
  pageIndex: number
  width: number
  height: number
  rotation: Rotation
  tokens: OCRToken[]
  candidates: SignatureCandidate[]
  previewDataUrl: string
  ocrDataUrl: string
  elapsedMs: number
}

export type TestJudgement = 'correct' | 'partial' | 'wrong' | 'failed'

export interface SavedResult {
  fileName: string
  timestamp: number
  score: number
  confidence: number
  pageIndex: number | null
  judgement: TestJudgement
}


export interface SignatureTarget {
  pageIndex: number
  rotation: Rotation
  rect: NormalizedRect
  source: 'date-anchor' | 'buyer-anchor' | 'blank-line' | 'fallback'
  confidence: number
}
