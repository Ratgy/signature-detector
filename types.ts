export type Rotation = 0

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

export interface OCRLine {
  text: string
  confidence: number
  rect: NormalizedRect
  pageIndex: number
}

export interface SigningBlock {
  pageIndex: number
  rect: NormalizedRect
  confidence: number
  score: number
  confirmLine: string
  dateLine: string
  signerLine: string
}

export interface FileResult {
  id: string
  fileName: string
  fileType: 'pdf' | 'image'
  status: 'queued' | 'processing' | 'success' | 'failed'
  progress: number
  message: string
  pageCount: number
  pageIndex: number | null
  confidence: number
  fullPreview: string | null
  cropPreview: string | null
  elapsedMs: number
  matched: { confirm:string; date:string; signer:string } | null
  judgement?: 'correct' | 'partial' | 'wrong' | 'failed'
}
