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

export interface SignatureTarget {
  pageIndex: number
  rotation: Rotation
  rect: NormalizedRect
  dateRect: NormalizedRect | null
  signerRect: NormalizedRect | null
  source: 'date-anchor' | 'buyer-anchor' | 'line-pair' | 'fallback'
  confidence: number
}

export interface DetectionCandidate {
  pageIndex: number
  rotation: Rotation
  score: number
  confidence: number
  target: SignatureTarget | null
  matchedTexts: string[]
}
