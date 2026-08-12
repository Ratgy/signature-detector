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

export interface SigningCluster {
  pageIndex: number
  rotation: Rotation
  rect: NormalizedRect
  rotatedRect: NormalizedRect
  confidence: number
  score: number
  matched: {
    confirm: string
    date: string
    signer: string
  }
}

export interface SourcePage {
  pageIndex: number
  rotation: Rotation
  canvas: HTMLCanvasElement
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
  rotation: Rotation
  confidence: number
  correctedPreview: string | null
  cropPreview: string | null
  elapsedMs: number
  matched: {confirm:string; date:string; signer:string} | null
  judgement?: 'correct' | 'partial' | 'wrong' | 'failed'
}
