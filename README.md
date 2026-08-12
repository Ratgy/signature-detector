# Signature Detector Batch v12.0
BUILD 12.0 · 2026-08-12

변경점
- 서로 다른 컬럼/서식 조각을 합친 후보는 즉시 폐기합니다.
- 날짜 + 매수인 + 서명/(인)이 한 로컬 블록 안에 있을 때만 성공 처리합니다.
- 최종 결과는 해당 블록 + 40px margin만 표시합니다.
- PDF는 텍스트 레이어로 페이지를 먼저 고르므로 OCR 페이지 탐색을 크게 줄였습니다.
- 스캔 PDF만 저해상도 OCR fallback을 사용합니다.
- JPG/PNG는 v11처럼 탐색 OCR + 정밀 OCR을 연속 실행하지 않고 바로 정밀 OCR합니다.
- 이미지 OCR은 sparse-text PSM, 300 DPI 힌트, strong preprocessing을 사용합니다.
- 실패 시 하단/중하단 ROI만 고해상도 재판독합니다.
